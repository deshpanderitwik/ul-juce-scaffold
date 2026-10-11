// ==========================================================================
// shell.js — Experiment shell
// ==========================================================================

(function () {
  'use strict';

  // ========================================================================
  // Three.js setup
  // ========================================================================
  const canvas = document.getElementById('canvas');
  const width  = window.innerWidth;
  const height = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  // Orthographic camera: origin at bottom-left, (width, height) at top-right
  const camera = new THREE.OrthographicCamera(0, width, height, 0, -1000, 1000);
  camera.position.z = 1;

  // ========================================================================
  // Resize handling
  // ========================================================================
  function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.left   = 0;
    camera.right  = w;
    camera.top    = h;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', handleResize);

  // ========================================================================
  // JUCE bridge — outgoing events and error forwarding
  // ========================================================================
  let backendReady = false;

  function emit(name, payload) {
    try {
      if (!backendReady) return;
      window.__JUCE__.backend.emitEvent(name, payload);
    } catch (e) {
      console.warn('Shell: emitEvent(' + name + ') failed', e);
    }
  }

  // Uncaught page errors are forwarded so they land in the C++ log. The same
  // error repeating every frame (a throwing update) is sent once a second,
  // not sixty times.
  let lastErrorKey  = '';
  let lastErrorTime = 0;

  function reportError(message, source, line) {
    try {
      const msg = String(message).slice(0, 500);
      const src = String(source || '').split('/').pop().split('?')[0];
      const ln  = Math.max(0, Math.floor(Number(line)) || 0);
      const key = msg + '|' + src + '|' + ln;
      const now = Date.now();
      if (key === lastErrorKey && now - lastErrorTime < 1000) return;
      lastErrorKey  = key;
      lastErrorTime = now;
      emit('jsError', { message: msg, source: src, line: ln });
    } catch (e) { /* the error reporter must never throw */ }
  }

  window.addEventListener('error', function (e) {
    reportError(e && e.message, e && e.filename, e && e.lineno);
  });

  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    reportError(r && r.message ? r.message : r, r && (r.sourceURL || r.fileName), r && (r.line || r.lineNumber));
  });

  // An error thrown by an experiment hook must not take the shell down with
  // it: log it, forward it, carry on.
  function reportCaught(err) {
    console.error(err);
    reportError(err && err.message ? err.message : err,
                err && (err.sourceURL || err.fileName),
                err && (err.line || err.lineNumber));
  }

  function callHook(experiment, name, ...args) {
    if (typeof experiment[name] !== 'function') return;
    try {
      experiment[name](...args);
    } catch (err) {
      reportCaught(err);
    }
  }

  // ========================================================================
  // JUCE bridge — transport state and the C++ step feed
  // ========================================================================
  const transport = {
    tempo:              120.0,
    beatPosition:       0.0,
    timeSigNumerator:   4,
    timeSigDenominator: 4,
    isPlaying:          false
  };

  function getTransport() {
    return transport;
  }

  // Index of the step the C++ sequencer most recently reported for the
  // current sequence and rate; -1 when nothing has played since the
  // transport stopped, the rate changed or another experiment took over.
  let lastStepIndex = -1;

  // Identifies the sequence C++ is playing. Starts random so a reloaded page
  // never matches the tag of a sequence left over from before the reload.
  const MAX_TAG = 0x7fffffff;
  let tag = 1 + Math.floor(Math.random() * (MAX_TAG - 1));

  function onTick(data) {
    if (!data) return;
    transport.tempo              = data.bpm              ?? 120.0;
    transport.beatPosition       = data.beatPosition     ?? 0.0;
    transport.timeSigNumerator   = data.timeSigNumerator ?? 4;
    transport.timeSigDenominator = data.timeSigDenominator ?? 4;
    transport.isPlaying          = data.isPlaying        ?? false;
    if (!transport.isPlaying) lastStepIndex = -1;

    const steps = data.steps;
    if (!Array.isArray(steps) || steps.length === 0) return;

    const spb = SUBDIVISIONS[currentSubdivision];
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k];
      // Steps from a sequence or rate the page no longer shows are stale.
      if (!s || s.tag !== tag || Math.abs(s.spb - spb) > 1e-9) continue;
      lastStepIndex = s.i;
      if (activeId !== null) {
        callHook(experiments.get(activeId).experiment, 'step', s.i, Array.isArray(s.played) ? s.played : []);
      }
    }
  }

  // ========================================================================
  // Persistent state — JSON blobs keyed by experiment id, stored in the
  // processor and saved/restored with the DAW project. The page does not
  // start any experiment until the first `state` event has arrived (see
  // boot), so load() is always answered synchronously.
  // ========================================================================
  let stateData     = {};     // key → JSON string
  let stateReceived = false;
  let scriptsLoaded = false;
  let booted        = false;

  function parseState(id) {
    if (typeof stateData[id] !== 'string' || stateData[id] === '') {
      return null;
    }
    try { return JSON.parse(stateData[id]); } catch (e) { return null; }
  }

  function onState(data) {
    // The host restored the plugin state while the page was open: whatever
    // the experiments hold in memory is stale, so start over from it.
    if (booted) {
      location.reload();
      return;
    }
    stateData = (data && data.web && typeof data.web === 'object') ? data.web : {};
    stateReceived = true;
    boot();
  }

  // ========================================================================
  // JUCE backend initialization
  // ========================================================================
  function initBackend() {
    if (typeof window.__JUCE__ === 'undefined' || !window.__JUCE__.backend) {
      setTimeout(initBackend, 50);
      return;
    }

    backendReady = true;
    window.__JUCE__.backend.addEventListener('state', onState);
    window.__JUCE__.backend.addEventListener('tick', onTick);
    emit('pageLoaded', {});
  }

  initBackend();

  // ------------------------------------------------------------------
  // Shell's own persisted state: key/scale/octave/subdivision/active
  // experiment, under the reserved store key 'shell'. `subdivision` is the
  // active experiment's value; `subdivisions` holds every experiment's own.
  // Saved on every change; applied once at boot.
  // ------------------------------------------------------------------
  function saveShellState() {
    shellStore.save({
      root:         currentRoot,
      scaleName:    currentScaleName,
      octave:       currentOctave,
      subdivision:  currentSubdivision,
      subdivisions: Object.fromEntries(subdivisionByExperiment),
      // While the sequencer still plays the sequence of an experiment that
      // did not load, that experiment stays the saved one.
      experiment:   unclaimedExperiment !== null ? unclaimedExperiment : activeId
    });
  }

  function applyShellState(s) {
    if (s) {
      if (typeof s.root === 'number' && s.root >= 0 && s.root < 12)       currentRoot = s.root;
      if (SCALES[s.scaleName])                                            currentScaleName = s.scaleName;
      if (typeof s.octave === 'number' && s.octave >= 0 && s.octave <= 7) currentOctave = s.octave;
      if (SUBDIVISIONS[s.subdivision])                                    currentSubdivision = s.subdivision;
      if (s.subdivisions && typeof s.subdivisions === 'object') {
        for (const key of Object.keys(s.subdivisions)) {
          if (SUBDIVISIONS[s.subdivisions[key]]) subdivisionByExperiment.set(key, s.subdivisions[key]);
        }
      }
    }

    keySelect.value         = String(currentRoot);
    scaleSelect.value       = currentScaleName;
    octaveSelect.value      = String(currentOctave);
    subdivisionSelect.value = currentSubdivision;
    lastStepIndex = -1;

    const wanted = s && typeof s.experiment === 'string' ? s.experiment : null;
    // State saved before subdivisions were kept per experiment only has the
    // active experiment's value.
    if (wanted && SUBDIVISIONS[s.subdivision] && !subdivisionByExperiment.has(wanted)) {
      subdivisionByExperiment.set(wanted, s.subdivision);
    }
    const missing = !!wanted && !experiments.has(wanted);
    const id = (wanted && !missing) ? wanted : experiments.keys().next().value;
    if (id === undefined) return;

    // The saved experiment did not load (shelved, or its script failed), so
    // C++ is playing a sequence nothing on this page can reproduce. The first
    // experiment is shown, but the sequencer stays untouched until the user
    // switches experiment or the shown one stores a sequence of its own.
    if (missing) unclaimedExperiment = wanted;
    activate(id, !missing);
  }

  // Nothing is activated or initialised before both halves are in: the saved
  // state (so no experiment starts from defaults and replaces a sequence C++
  // is already playing) and the experiment scripts.
  function boot() {
    if (booted || !stateReceived || !scriptsLoaded) return;
    booted = true;
    shellStore.load(applyShellState);
  }

  function makeStore(id) {
    // Saving before load() has run would overwrite the saved state with
    // whatever the experiment holds at boot, so it is dropped.
    let loaded = false;

    return {
      // Persist a JSON-serializable value as this experiment's saved state.
      save(value) {
        if (!loaded) return;
        const json = JSON.stringify(value);
        if (typeof json !== 'string') return;
        stateData[id] = json;
        emit('saveState', { key: id, value: json });
      },

      // Load this experiment's saved state. The callback is invoked
      // synchronously with the saved value, or null if there is none.
      load(callback) {
        callback(parseState(id));
        loaded = true;
      }
    };
  }

  const shellStore = makeStore('shell');

  // ========================================================================
  // Utilities
  // ========================================================================
  function getSize() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  // ========================================================================
  // Key / Scale system
  // ========================================================================
  const ROOT_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  const SCALES = {
    'major':            [0, 2, 4, 5, 7, 9, 11],
    'dorian':           [0, 2, 3, 5, 7, 9, 10],
    'phrygian':         [0, 1, 3, 5, 7, 8, 10],
    'lydian':           [0, 2, 4, 6, 7, 9, 11],
    'mixolydian':       [0, 2, 4, 5, 7, 9, 10],
    'minor':            [0, 2, 3, 5, 7, 8, 10],
    'locrian':          [0, 1, 3, 5, 6, 8, 10],
    'pentatonic-major': [0, 2, 4, 7, 9],
    'pentatonic-minor': [0, 3, 5, 7, 10],
    'blues':            [0, 3, 5, 6, 7, 10],
  };

  const SCALE_DISPLAY_NAMES = {
    'major':            'Major',
    'dorian':           'Dorian',
    'phrygian':         'Phrygian',
    'lydian':           'Lydian',
    'mixolydian':       'Mixolydian',
    'minor':            'Minor',
    'locrian':          'Locrian',
    'pentatonic-major': 'Pent. Major',
    'pentatonic-minor': 'Pent. Minor',
    'blues':            'Blues',
  };

  // Defaults until the saved state arrives.
  let currentRoot      = 0;
  let currentScaleName = 'major';
  let currentOctave    = 3;
  const scaleListeners = [];

  // ========================================================================
  // Subdivision system (for quantized experiments)
  // ========================================================================
  // Values are steps per beat; fractional = multi-beat steps ('1bar' assumes 4/4)
  const SUBDIVISIONS = {
    '1bar': 0.25,
    '1/2':  0.5,
    '1/4':  1,
    '1/8':  2,
    '1/8T': 3,
    '1/16': 4,
  };

  const SUBDIVISION_DISPLAY = {
    '1bar': '1 bar',
    '1/2':  '1/2',
    '1/4':  '1/4',
    '1/8':  '1/8',
    '1/8T': '1/8T',
    '1/16': '1/16',
  };

  // What the selector offers unless an experiment declares its own
  // `subdivisions` list.
  const DEFAULT_SUBDIVISIONS = ['1/4', '1/8', '1/8T', '1/16'];

  let currentSubdivision = '1/8';

  // The subdivision each quantized experiment last used (id -> key). The
  // current one is a single global value, so without this an experiment whose
  // list lacks it would overwrite it for the experiment the user came from.
  const subdivisionByExperiment = new Map();

  function getSubdivision() {
    return { key: currentSubdivision, stepsPerBeat: SUBDIVISIONS[currentSubdivision] };
  }

  function notifyScaleChange() {
    const info = {
      root:      ROOT_NAMES[currentRoot],
      scaleName: currentScaleName,
      intervals: SCALES[currentScaleName],
      octave:    currentOctave
    };
    // One failing listener must not keep the others, or the save, from running.
    for (const cb of scaleListeners) {
      try {
        cb(info);
      } catch (err) {
        reportCaught(err);
      }
    }
    saveShellState();
  }

  const scale = {
    getKey() {
      return { root: ROOT_NAMES[currentRoot], scaleName: currentScaleName };
    },

    getNotesInRange(lowMidi, highMidi) {
      const intervals = SCALES[currentScaleName];
      const notes = [];
      for (let midi = lowMidi; midi <= highMidi; midi++) {
        const pc = ((midi % 12) - currentRoot + 12) % 12;
        if (intervals.includes(pc)) notes.push(midi);
      }
      return notes;
    },

    getScaleDegree(midiNote) {
      const pc = ((midiNote % 12) - currentRoot + 12) % 12;
      const idx = SCALES[currentScaleName].indexOf(pc);
      return idx >= 0 ? idx + 1 : null;
    },

    getNoteForDegree(degree, octave) {
      const intervals = SCALES[currentScaleName];
      const idx = ((degree - 1) % intervals.length + intervals.length) % intervals.length;
      return currentRoot + intervals[idx] + (octave + 1) * 12;
    },

    getScaleLength() {
      return SCALES[currentScaleName].length;
    },

    getBaseOctave() {
      return currentOctave + 1;
    },

    onChange(callback) {
      scaleListeners.push(callback);
      return function unsubscribe() {
        const i = scaleListeners.indexOf(callback);
        if (i >= 0) scaleListeners.splice(i, 1);
      };
    },

    getNoteName(midiNote) {
      const name   = NOTE_NAMES[((midiNote % 12) + 12) % 12];
      const octave = Math.floor(midiNote / 12) - 2;
      return name + octave;
    }
  };

  // ========================================================================
  // Experiment files. Each file self-registers with its own metadata
  // (id, name, description) via Shell.register(behavior). This list only
  // tells the loader which scripts to fetch and in what order.
  // ========================================================================
  const EXPERIMENT_FILES = ['test.js', 'scribbler.js', 'graph.js', 'chord-builder.js'];

  // Shelved — files stay in web/ but aren't loaded, so they don't appear in
  // the selector. Move a name back into EXPERIMENT_FILES to bring it back.
  // eslint-disable-next-line no-unused-vars
  const HIDDEN_EXPERIMENT_FILES = ['scratch.js', 'random-walker.js', 'scale-flick.js'];

  // ========================================================================
  // Experiment lifecycle
  // ========================================================================
  const experiments = new Map();   // id → { experiment, group, initialized, midi, held, sequence, ... }
  let activeId = null;

  // ------------------------------------------------------------------
  // Step sequence. Each experiment owns the sequence it last stored; only
  // the active experiment's is ever sent. Sends are coalesced to one per
  // frame (see flushSequence) so an experiment may call setStepSequence as
  // often as it likes.
  // ------------------------------------------------------------------
  const MAX_STEPS          = 256;
  const MAX_NOTES_PER_STEP = 48;
  const DEFAULT_DURATION   = 150;
  let sequenceDirty = false;

  // Id of the experiment named by the saved state when it is not registered;
  // null once the sequencer has been handed to an experiment of this page.
  let unclaimedExperiment = null;

  function handOverSequencer() {
    sequenceDirty = true;
    unclaimedExperiment = null;
  }

  function finiteOr(x, fallback) {
    return (typeof x === 'number' && isFinite(x)) ? x : fallback;
  }

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  function normaliseNote(raw) {
    const o = (typeof raw === 'number') ? { n: raw } : raw;
    if (!o || typeof o !== 'object' || typeof o.n !== 'number' || !isFinite(o.n)) return null;
    return {
      n: clamp(Math.round(o.n), 0, 127),
      d: clamp(finiteOr(o.d, 0), 0, 0.99),
      p: clamp(finiteOr(o.p, 1), 0, 1),
      v: clamp(Math.round(finiteOr(o.v, 100)), 1, 127)
    };
  }

  // Canonical form, or null if the sequence is too big. An oversized
  // sequence is refused rather than truncated: cutting steps off would
  // change the loop length.
  function normaliseSequence(steps) {
    if (steps === null || steps === undefined) steps = [];
    if (!Array.isArray(steps)) {
      console.warn('Shell: setStepSequence expects an array of steps');
      return null;
    }
    if (steps.length > MAX_STEPS) {
      console.warn('Shell: sequence of ' + steps.length + ' steps exceeds ' + MAX_STEPS + '; keeping the previous sequence');
      return null;
    }
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const raw  = steps[i];
      const list = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
      if (list.length > MAX_NOTES_PER_STEP) {
        console.warn('Shell: step ' + i + ' has ' + list.length + ' notes (max ' + MAX_NOTES_PER_STEP + '); keeping the previous sequence');
        return null;
      }
      const step = [];
      for (let j = 0; j < list.length; j++) {
        const note = normaliseNote(list[j]);
        if (note) step.push(note);
      }
      out.push(step);
    }
    return out;
  }

  function flushSequence() {
    if (!sequenceDirty || !booted) return;
    sequenceDirty = false;
    const entry = activeId !== null ? experiments.get(activeId) : null;
    emit('setStepSequence', {
      steps:        entry && entry.sequence ? entry.sequence : [],
      stepsPerBeat: SUBDIVISIONS[currentSubdivision],
      durationMs:   entry ? entry.durationMs : DEFAULT_DURATION,
      legato:       entry ? entry.legato : false,
      tag
    });
  }

  // ------------------------------------------------------------------
  // Per-experiment MIDI handle. Its notes are inert unless its experiment is
  // the active one, so a paused experiment cannot make sound; the notes it
  // holds open are released when it is deactivated. A sequence is stored
  // whether or not the experiment is active (an experiment that rebuilds on
  // a key change while paused must hand over the rebuilt one on resume) and
  // only sent while it is.
  // ------------------------------------------------------------------
  function makeMidiHandle(id, entry) {
    const isActive = function () { return activeId === id; };

    return {
      sendNoteOn(note, velocity = 100, channel = 1) {
        if (!isActive()) return;
        const n  = clamp(Math.round(finiteOr(note, 60)), 0, 127);
        const v  = clamp(Math.round(finiteOr(velocity, 100)), 1, 127);
        const ch = clamp(Math.round(finiteOr(channel, 1)), 1, 16);
        entry.held.set(ch + ':' + n, { note: n, channel: ch });
        emit('midi', { type: 'noteOn', note: n, velocity: v, channel: ch, durationMs: 0 });
      },

      sendNoteOff(note, channel = 1) {
        if (!isActive()) return;
        const n  = clamp(Math.round(finiteOr(note, 60)), 0, 127);
        const ch = clamp(Math.round(finiteOr(channel, 1)), 1, 16);
        entry.held.delete(ch + ':' + n);
        emit('midi', { type: 'noteOff', note: n, velocity: 0, channel: ch, durationMs: 0 });
      },

      // C++ turns the note off after durationMs; a JS timer would leave the
      // note stuck if the page went away first.
      sendNote(note, velocity, channel, durationMs) {
        if (!isActive()) return;
        emit('midi', {
          type:       'note',
          note:       clamp(Math.round(finiteOr(note, 60)), 0, 127),
          velocity:   clamp(Math.round(finiteOr(velocity, 100)), 1, 127),
          channel:    clamp(Math.round(finiteOr(channel, 1)), 1, 16),
          durationMs: Math.max(1, Math.round(finiteOr(durationMs, DEFAULT_DURATION)))
        });
      },

      setStepSequence(steps, durationMs, legato) {
        const sequence = normaliseSequence(steps);
        if (sequence === null) return;
        entry.sequence   = sequence;
        entry.durationMs = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : DEFAULT_DURATION;
        entry.legato     = !!legato;
        if (isActive()) handOverSequencer();
      }
    };
  }

  function releaseHeldNotes(entry) {
    entry.held.forEach(function (h) {
      emit('midi', { type: 'noteOff', note: h.note, velocity: 0, channel: h.channel, durationMs: 0 });
    });
    entry.held.clear();
  }

  // A closing window must not leave notes sounding.
  window.addEventListener('pagehide', function () {
    if (activeId !== null) releaseHeldNotes(experiments.get(activeId));
  });

  // ------------------------------------------------------------------
  // Three.js resource helpers handed to experiments
  // ------------------------------------------------------------------
  function disposeObject(obj) {
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  }

  function disposeGroup(group) {
    if (!group) return;
    const descendants = [];
    group.traverse(function (o) { if (o !== group) descendants.push(o); });
    for (const o of descendants) {
      disposeObject(o);
      if (o.parent) o.parent.remove(o);
    }
  }

  function buildContext(group, id, entry) {
    return {
      scene:        group,       // THREE.Group — experiment adds meshes here
      camera,                    // read-only reference
      renderer,                  // read-only reference
      midi:         entry.midi,  // per-experiment handle
      scale,
      store:        makeStore(id),  // per-experiment persistent state
      getTransport,
      getSize,
      getSubdivision,
      getStepIndex() { return lastStepIndex; },
      setCursor(css) { if (activeId === id) canvas.style.cursor = css || ''; },
      util:         { disposeObject, disposeGroup }
    };
  }

  function register(behavior) {
    if (!behavior || !behavior.id) {
      console.warn('Shell.register: behavior must include an id');
      return;
    }
    const id = behavior.id;
    if (experiments.has(id)) {
      console.warn('Shell.register: "' + id + '" already registered');
      return;
    }
    const experiment = Object.assign({ name: id, description: '' }, behavior);
    const entry = {
      experiment,
      group:       new THREE.Group(),
      initialized: false,
      held:        new Map(),       // notes turned on with sendNoteOn and not yet off
      sequence:    null,            // canonical steps, or null if never set
      durationMs:  DEFAULT_DURATION,
      legato:      false
    };
    entry.midi = makeMidiHandle(id, entry);
    experiments.set(id, entry);

    // Append to the experiment selector dropdown
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = experiment.name;
    experimentSelect.appendChild(opt);

    updateSelector();
  }

  // `handOver: false` leaves the sequencer alone (see applyShellState).
  function activate(id, handOver = true) {
    // Before boot the saved state has not arrived, so nothing may start.
    if (!booted) { updateSelector(); return; }
    if (!experiments.has(id)) return;
    if (activeId === id) return;

    // Pause the current experiment
    if (activeId !== null) {
      const current = experiments.get(activeId);
      scene.remove(current.group);
      callHook(current.experiment, 'pause');
      releaseHeldNotes(current);
      canvas.style.cursor = '';
    }

    // Activate the new experiment
    const entry = experiments.get(id);
    activeId = id;
    tag = (tag % MAX_TAG) + 1;
    lastStepIndex = -1;
    scene.add(entry.group);

    // Show/hide subdivision selector based on whether experiment is quantized
    var isQuantized = typeof entry.experiment.step === 'function';
    divider2.style.display = isQuantized ? '' : 'none';
    subdivisionSelect.style.display = isQuantized ? '' : 'none';
    if (isQuantized) {
      rebuildSubdivisionOptions(entry.experiment.subdivisions || DEFAULT_SUBDIVISIONS,
                                subdivisionByExperiment.get(id));
      subdivisionByExperiment.set(id, currentSubdivision);
    }

    // Experiments that span a fixed octave range can opt out of the octave picker
    octaveSelect.style.display = entry.experiment.showOctave === false ? 'none' : '';

    if (!entry.initialized) {
      entry.initialized = true;
      callHook(entry.experiment, 'init', buildContext(entry.group, id, entry));
    } else {
      callHook(entry.experiment, 'resume');
    }

    // Whatever the new experiment stored is handed to the sequencer at the
    // end of the frame.
    if (handOver) handOverSequencer();

    updateSelector();
    saveShellState();
  }

  function setSubdivision(key) {
    currentSubdivision = key;
    if (activeId !== null) subdivisionByExperiment.set(activeId, key);
    lastStepIndex = -1;
    handOverSequencer();
    saveShellState();
    if (activeId !== null) {
      callHook(experiments.get(activeId).experiment, 'onSubdivisionChange', getSubdivision());
    }
  }

  // Expose to global scope so experiment scripts can call Shell.register()
  window.Shell = {
    register,
    activate,
    getStats() {
      return {
        frames:   frameCount,
        activeId,
        ids:      Array.from(experiments.keys()),
        tag,
        booted
      };
    }
  };

  // ========================================================================
  // Top bar UI — experiment selector + key/scale selectors
  // ========================================================================
  var selectStyle =
    'background:rgba(255,255,255,0.08); border:none; color:#ccc;' +
    'font-size:12px; padding:5px 8px; border-radius:8px; outline:none;' +
    'cursor:pointer; font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
    '-webkit-appearance:none; appearance:none; min-width:0;';

  var topBar = document.createElement('div');
  topBar.style.cssText =
    'position:fixed; top:10px; left:50%; transform:translateX(-50%);' +
    'display:flex; align-items:center; gap:6px; z-index:100; padding:4px 8px;' +
    'background:rgba(0,0,0,0.4); border-radius:16px; backdrop-filter:blur(8px);';
  document.body.appendChild(topBar);

  // --- Experiment dropdown (populated as experiments self-register) ---
  var experimentSelect = document.createElement('select');
  experimentSelect.style.cssText = selectStyle;
  experimentSelect.addEventListener('change', function () {
    activate(experimentSelect.value);
  });
  topBar.appendChild(experimentSelect);

  // --- Divider ---
  var divider = document.createElement('div');
  divider.style.cssText =
    'width:1px; height:18px; background:rgba(255,255,255,0.15); margin:0 4px;';
  topBar.appendChild(divider);

  // --- Key selector ---
  var keySelect = document.createElement('select');
  keySelect.style.cssText = selectStyle;
  for (var ri = 0; ri < ROOT_NAMES.length; ri++) {
    var opt = document.createElement('option');
    opt.value = ri;
    opt.textContent = ROOT_NAMES[ri];
    if (ri === currentRoot) opt.selected = true;
    keySelect.appendChild(opt);
  }
  keySelect.addEventListener('change', function () {
    currentRoot = parseInt(keySelect.value, 10);
    notifyScaleChange();
  });
  topBar.appendChild(keySelect);

  // --- Scale selector ---
  var scaleSelect = document.createElement('select');
  scaleSelect.style.cssText = selectStyle;
  var scaleKeys = Object.keys(SCALES);
  for (var si = 0; si < scaleKeys.length; si++) {
    var opt = document.createElement('option');
    opt.value = scaleKeys[si];
    opt.textContent = SCALE_DISPLAY_NAMES[scaleKeys[si]];
    if (scaleKeys[si] === currentScaleName) opt.selected = true;
    scaleSelect.appendChild(opt);
  }
  scaleSelect.addEventListener('change', function () {
    currentScaleName = scaleSelect.value;
    notifyScaleChange();
  });
  topBar.appendChild(scaleSelect);

  // --- Octave selector ---
  var octaveSelect = document.createElement('select');
  octaveSelect.style.cssText = selectStyle;
  for (var oi = 0; oi <= 7; oi++) {
    var opt = document.createElement('option');
    opt.value = oi;
    opt.textContent = 'Oct ' + oi;
    if (oi === currentOctave) opt.selected = true;
    octaveSelect.appendChild(opt);
  }
  octaveSelect.addEventListener('change', function () {
    currentOctave = parseInt(octaveSelect.value, 10);
    notifyScaleChange();
  });
  topBar.appendChild(octaveSelect);

  // --- Divider + Subdivision selector (hidden until a quantized experiment is active) ---
  var divider2 = document.createElement('div');
  divider2.style.cssText =
    'width:1px; height:18px; background:rgba(255,255,255,0.15); margin:0 4px; display:none;';
  topBar.appendChild(divider2);

  var subdivisionSelect = document.createElement('select');
  subdivisionSelect.style.cssText = selectStyle;
  subdivisionSelect.style.display = 'none';

  // (Re)populate the subdivision dropdown from a list of SUBDIVISIONS keys.
  // The experiment's own last choice (`preferred`) wins if it is offered, then
  // the current choice; otherwise fall back. The caller sends the sequence.
  function rebuildSubdivisionOptions(allowed, preferred) {
    while (subdivisionSelect.firstChild) {
      subdivisionSelect.removeChild(subdivisionSelect.firstChild);
    }
    for (var sdi = 0; sdi < allowed.length; sdi++) {
      var key = allowed[sdi];
      if (!SUBDIVISIONS[key]) continue;
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = SUBDIVISION_DISPLAY[key];
      subdivisionSelect.appendChild(opt);
    }
    if (preferred !== undefined && allowed.indexOf(preferred) !== -1) {
      currentSubdivision = preferred;
    } else if (allowed.indexOf(currentSubdivision) === -1) {
      currentSubdivision = allowed.indexOf('1/8') !== -1 ? '1/8' : allowed[0];
    }
    subdivisionSelect.value = currentSubdivision;
  }
  // NOTE: no initial population — the selector stays empty (and hidden)
  // until a quantized experiment activates and supplies its list. Populating
  // it with the default list here would coerce a saved '1bar'/'1/2' choice
  // back to '1/8' before the experiment that supports it gets a say.

  subdivisionSelect.addEventListener('change', function () {
    setSubdivision(subdivisionSelect.value);
  });
  topBar.appendChild(subdivisionSelect);

  // --- Divider + Reload button ---
  var divider3 = document.createElement('div');
  divider3.style.cssText =
    'width:1px; height:18px; background:rgba(255,255,255,0.15); margin:0 4px;';
  topBar.appendChild(divider3);

  var reloadBtn = document.createElement('button');
  reloadBtn.textContent = '\u21BB';   // ↻
  reloadBtn.title = 'Reload';
  reloadBtn.style.cssText =
    'padding:4px 8px; border:none; border-radius:8px; font-size:14px;' +
    'background:transparent; color:#777; cursor:pointer; transition:all 0.15s;' +
    'outline:none; font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  reloadBtn.addEventListener('mouseenter', function () {
    reloadBtn.style.background = 'rgba(255,255,255,0.08)';
    reloadBtn.style.color = '#fff';
  });
  reloadBtn.addEventListener('mouseleave', function () {
    reloadBtn.style.background = 'transparent';
    reloadBtn.style.color = '#777';
  });
  reloadBtn.addEventListener('click', function () { location.reload(); });
  topBar.appendChild(reloadBtn);

  function updateSelector() {
    experimentSelect.value = activeId || '';
  }

  // ========================================================================
  // Pointer input — forwarded to the active experiment in world
  // coordinates (origin bottom-left, like the camera).
  // ========================================================================
  function forwardPointer(hook, e) {
    if (activeId === null) return;
    const experiment = experiments.get(activeId).experiment;
    if (typeof experiment[hook] !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    experiment[hook]({
      x: e.clientX - rect.left,
      y: rect.height - (e.clientY - rect.top)
    }, e);
  }

  canvas.addEventListener('pointerdown', function (e) {
    // Capture keeps a drag reporting over the top bar and outside the canvas.
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-gone pointer */ }
    forwardPointer('onPointerDown', e);
  });
  canvas.addEventListener('pointermove',   function (e) { forwardPointer('onPointerMove', e); });
  canvas.addEventListener('pointerup',     function (e) { forwardPointer('onPointerUp', e); });
  canvas.addEventListener('pointercancel', function (e) { forwardPointer('onPointerCancel', e); });
  canvas.addEventListener('dblclick',      function (e) { forwardPointer('onDoubleClick', e); });

  // ========================================================================
  // Animation loop
  // ========================================================================
  const clock = new THREE.Clock();

  // When the page is backgrounded, rAF pauses but the clock keeps ticking.
  // Drain the accumulated delta on return so experiments don't get a huge
  // time step that jolts resting physics bodies into false collisions.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) clock.getDelta();
  });

  let frameCount = 0;

  function animate() {
    requestAnimationFrame(animate);
    frameCount++;
    const delta = clock.getDelta();
    const tp    = getTransport();

    // Transport dimming for quantized experiments. Which step played comes
    // from the C++ sequencer (see onTick), not from the transport position.
    if (activeId !== null) {
      const entry = experiments.get(activeId);
      if (typeof entry.experiment.step === 'function') {
        var dimTarget = tp.isPlaying ? 1.0 : 0.3;
        var current   = entry.group.userData.dimFactor ?? 1.0;
        var next      = current + (dimTarget - current) * Math.min(1, delta * 8);
        entry.group.userData.dimFactor = next;
      }
    }

    // Update the active experiment
    if (activeId !== null) {
      const entry = experiments.get(activeId);
      if (entry.experiment.update) {
        try {
          entry.experiment.update(delta, tp);
        } catch (err) {
          reportCaught(err);
        }
      }
    }

    flushSequence();
    renderer.render(scene, camera);
  }
  animate();

  // ========================================================================
  // Dynamic experiment loader
  // ========================================================================
  function loadScript(src) {
    return new Promise(function (resolve) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        console.warn('Shell: failed to load ' + src);
        resolve();
      };
      document.body.appendChild(s);
    });
  }

  (function loadExperiments() {
    const cfg   = window.SHELL_CONFIG;
    const files = (cfg && Array.isArray(cfg.experimentFiles)) ? cfg.experimentFiles : EXPERIMENT_FILES;
    let chain = Promise.resolve();
    for (const file of files) {
      chain = chain.then(() => loadScript(file));
    }
    chain.then(() => {
      scriptsLoaded = true;
      boot();
    });
  })();

})();
