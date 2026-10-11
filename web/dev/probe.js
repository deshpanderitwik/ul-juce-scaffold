// ==========================================================================
// probe.js — two tiny experiments that exercise every ctx call and every
// optional hook once, and record what happened on window.__probe so the
// autotest can assert the shell's side of the experiment contract. Needs
// dev/mock-juce.js (it reads window.__mock). Not bundled into the plugin.
//
// probeQuiet=1 in the page URL stops the probe from storing any sequence of
// its own at init or in the burst, for the autotest cases that check what the
// shell does with the sequencer when nothing has asked it to hand over.
// ==========================================================================

(function () {
  'use strict';

  const QUIET = new URLSearchParams(location.search).get('probeQuiet') === '1';

  const P = window.__probe = {
    ctx: null,

    inits: 0,
    pauses: 0,
    resumes: 0,
    destroys: 0,

    // store
    saveBeforeLoadEmitted: null,   // saveState messages caused by a save made before load()
    saveInsideLoadEmitted: null,   // ... and by one made inside the load callback
    loadSync: null,
    loadedValue: undefined,
    saveAfterLoadEmitted: null,
    savedByShell: null,

    // setStepSequence coalescing
    burst: { state: QUIET ? 'skipped' : 'idle', frame: 0, before: 0, delta: null, lastSteps: null, expectedSteps: 3 },

    // scale listeners: a throwing one is subscribed first and must not stop
    // the recorder behind it
    armScaleThrow: false,
    scaleThrows: 0,
    scaleCalls: [],                // { root, scaleName, octave } per onChange the recorder saw

    // the sequence probe-b writes through probe's handle while probe is paused
    pausedWrite: { steps: [[71], [72]], durationMs: 90, legato: true },

    // sendNote / handle behaviour
    sendNoteDelta: null,
    noteOnDelta: null,
    staleHandleDelta: null,        // messages emitted by probe's handle while probe-b is active

    // pointer
    pointer: [],                   // { hook, x, y, button, type }

    // step
    stepCalls: 0,
    lastStep: null,                // { i, played }
    playedAlwaysArray: true,
    stepIndexMatches: true,
    sawNonEmptyPlayed: false,
    stepIndices: [],               // every index step() received

    // subdivision
    subChanges: [],                // { key, stepsPerBeat, stepIndex }
    subdivisionAtInit: null,
    subdivisionAtResume: null,

    // update
    updateFrames: 0,
    transportKeys: null,
    transportDelta: null,

    // misc
    cursorAfterSet: null,
    dispose: null
  };

  const mock = function () { return window.__mock; };
  const msgCount = function (key) { return (mock().counts[key] || 0); };

  const NOTE = function (n) { return { n, d: 0, p: 1, v: 100 }; };

  // ----------------------------------------------------------------------
  // probe — the experiment under test
  // ----------------------------------------------------------------------
  Shell.register({
    id:          'probe',
    name:        'Probe',
    description: 'Contract probe for the dev harness',

    init(ctx) {
      P.inits++;
      P.ctx = ctx;
      this._ctx = ctx;

      // --- store: a save before load is dropped, one inside load is too,
      // load answers synchronously, a save afterwards goes out.
      let before = msgCount('saveState:probe');
      ctx.store.save({ early: true });
      P.saveBeforeLoadEmitted = msgCount('saveState:probe') - before;

      let sync = false;
      ctx.store.load(function (value) {
        sync = true;
        P.loadedValue = value;
        const b = msgCount('saveState:probe');
        ctx.store.save({ insideLoad: true });
        P.saveInsideLoadEmitted = msgCount('saveState:probe') - b;
      });
      P.loadSync = sync;

      before = msgCount('saveState:probe');
      const visits = (P.loadedValue && typeof P.loadedValue.visits === 'number' ? P.loadedValue.visits : 0) + 1;
      ctx.store.save({ visits });
      P.saveAfterLoadEmitted = msgCount('saveState:probe') - before;
      try { P.savedByShell = JSON.parse(mock().saved().probe); } catch (e) { P.savedByShell = null; }

      // --- sequence, canonical and shorthand forms mixed
      this._sequence = [[60, 64], [NOTE(62)], [], [{ n: 67, p: 0.5 }]];
      if (!QUIET) ctx.midi.setStepSequence(this._sequence, 120, false);

      // --- scale listeners
      ctx.scale.onChange(function () {
        if (!P.armScaleThrow) return;
        P.scaleThrows++;
        throw new Error('probe scale listener');
      });
      ctx.scale.onChange(function (info) {
        P.scaleCalls.push({ root: info.root, scaleName: info.scaleName, octave: info.octave });
      });

      // --- note that stays on until the shell releases it on deactivation
      before = msgCount('midi:noteOn');
      ctx.midi.sendNoteOn(61);
      P.noteOnDelta = msgCount('midi:noteOn') - before;

      P.subdivisionAtInit = ctx.getSubdivision();

      // --- dispose helpers
      this._testDispose(ctx);
    },

    _testDispose(ctx) {
      const counts = { geometry: 0, material: 0, map: 0 };
      const spy = function (obj, kind) {
        const original = obj.dispose.bind(obj);
        obj.dispose = function () { counts[kind]++; original(); };
        return obj;
      };
      const mesh = function (materialOrArray) {
        return new THREE.Mesh(spy(new THREE.PlaneGeometry(1, 1), 'geometry'), materialOrArray);
      };
      const basic = function (withMap) {
        const m = spy(new THREE.MeshBasicMaterial(), 'material');
        if (withMap) {
          const c = document.createElement('canvas');
          c.width = c.height = 2;
          m.map = spy(new THREE.CanvasTexture(c), 'map');
        }
        return m;
      };

      const sub    = new THREE.Group();
      const nested = new THREE.Group();
      ctx.scene.add(sub);
      sub.add(mesh(basic(true)));
      nested.add(mesh([basic(false), basic(false)]));
      sub.add(nested);

      const lone = mesh(basic(true));
      ctx.util.disposeObject(lone);
      const afterObject = Object.assign({}, counts);

      const descendantsBefore = (function () { let n = 0; sub.traverse(function () { n++; }); return n - 1; })();
      ctx.util.disposeGroup(sub);
      P.dispose = {
        disposeObject: afterObject,                       // expect geometry 1, material 1, map 1
        disposeGroup:  Object.assign({}, counts),         // expect geometry 3, material 4, map 2 in total
        descendantsBefore,                                // expect 3: two meshes and the nested group
        childrenAfter: sub.children.length,
        nestedChildrenAfter: nested.children.length
      };
    },

    update(delta, transport) {
      P.updateFrames++;
      P.transportKeys = Object.keys(transport).sort();

      // After the first flush has gone out, exercise the per-frame
      // coalescing: three stores in one frame, one message at the frame's end.
      const b = P.burst;
      if (b.state === 'idle' && P.updateFrames >= 10) {
        b.state = 'sent';
        b.before = msgCount('setStepSequence');
        this._ctx.midi.setStepSequence([[48]], 150, false);
        this._ctx.midi.setStepSequence([[50], [52]], 150, false);
        this._ctx.midi.setStepSequence([[53], [55], [57]], 150, false);
        this._sequence = [[53], [55], [57]];
        const nb = msgCount('midi:note');
        this._ctx.midi.sendNote(64, 90, 1, 120);
        P.sendNoteDelta = msgCount('midi:note') - nb;
        b.frame = P.updateFrames;
      } else if (b.state === 'sent' && P.updateFrames > b.frame) {
        b.state = 'done';
        b.delta = msgCount('setStepSequence') - b.before;
        const seq = mock().lastSequence;
        b.lastSteps = seq ? seq.steps.map(function (s) { return s.map(function (n) { return n.n; }); }) : null;
      }
    },

    step(stepIndex, played) {
      P.stepCalls++;
      P.stepIndices.push(stepIndex);
      P.lastStep = { i: stepIndex, played };
      if (!Array.isArray(played)) P.playedAlwaysArray = false;
      else if (played.length) P.sawNonEmptyPlayed = true;
      if (this._ctx.getStepIndex() !== stepIndex) P.stepIndexMatches = false;
    },

    onSubdivisionChange(sub) {
      P.subChanges.push({ key: sub.key, stepsPerBeat: sub.stepsPerBeat, stepIndex: this._ctx.getStepIndex() });
    },

    onPointerDown(p, e)   { this._pointer('onPointerDown', p, e); this._ctx.setCursor('crosshair'); P.cursorAfterSet = document.getElementById('canvas').style.cursor; },
    onPointerMove(p, e)   { this._pointer('onPointerMove', p, e); },
    onPointerUp(p, e)     { this._pointer('onPointerUp', p, e); },
    onPointerCancel(p, e) { this._pointer('onPointerCancel', p, e); },
    onDoubleClick(p, e)   { this._pointer('onDoubleClick', p, e); },

    _pointer(hook, p, e) {
      P.pointer.push({ hook, x: p.x, y: p.y, button: e.button, type: e.type });
    },

    pause() {
      P.pauses++;
    },

    resume() {
      P.resumes++;
      P.subdivisionAtResume = this._ctx.getSubdivision();
    },

    destroy() {
      P.destroys++;
    }
  });

  // ----------------------------------------------------------------------
  // probe-b — a second experiment so the autotest can switch away from the
  // probe and watch the shell clean up after it. It also pokes the probe's
  // stale handle, which must stay silent while the probe is not active.
  // ----------------------------------------------------------------------
  Shell.register({
    id:          'probe-b',
    name:        'Probe B',
    description: 'Second probe experiment, used for switching',
    // Narrower than the default list, so switching to it from a rate it does
    // not offer makes the shell pick another one.
    subdivisions: ['1/2', '1/4'],

    init(ctx) {
      this._ctx = ctx;
      window.__probe.bInits = (window.__probe.bInits || 0) + 1;

      const stale = P.ctx && P.ctx.midi;
      if (stale) {
        const before = mock().messages.length;
        stale.sendNoteOn(99);
        stale.sendNote(98, 100, 1, 100);
        stale.setStepSequence(P.pausedWrite.steps, P.pausedWrite.durationMs, P.pausedWrite.legato);
        P.staleHandleDelta = mock().messages.length - before;
      }
    },

    update() {},
    step() {}
  });
})();
