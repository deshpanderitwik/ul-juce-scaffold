// ==========================================================================
// autotest.js — self-test for the dev harness (dev.html?autotest=1).
// Writes { pass, checks: [{ name, pass, detail }] } as JSON into
// <pre id="autotest-result"> and sets document.title to 'AUTOTEST PASS' or
// 'AUTOTEST FAIL'. With probe=1 it also asserts everything dev/probe.js
// recorded. Not bundled into the plugin.
// ==========================================================================

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const checks = [];

  const out = document.createElement('pre');
  out.id = 'autotest-result';
  out.textContent = 'running';
  document.body.appendChild(out);

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const same  = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  const mock  = function () { return window.__mock; };
  const stats = function () { return window.Shell.getStats(); };

  function check(name, pass, detail) {
    checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  }

  async function waitFor(fn, timeoutMs) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (fn()) return true;
      await sleep(25);
    }
    return !!fn();
  }

  function finish() {
    const pass = checks.every(function (c) { return c.pass; });
    out.textContent = JSON.stringify({ pass, checks }, null, 1);
    document.title = pass ? 'AUTOTEST PASS' : 'AUTOTEST FAIL';
    window.__autotest = { pass, checks };
  }

  // Activate an experiment and wait until the sequencer has been handed over
  // (the shell sends at the end of a frame), then let it run a moment.
  async function activateAndSettle(id) {
    window.Shell.activate(id);
    await waitFor(function () { return mock().lastSequence && mock().lastSequence.tag === stats().tag; }, 3000);
    await sleep(300);
  }

  function playFor(ms) {
    mock().setBpm(240);
    mock().play();
    return sleep(ms);
  }

  // ----------------------------------------------------------------------
  // Probe-specific checks
  // ----------------------------------------------------------------------
  // The subdivision selector is the only select that offers a note value.
  function findSubdivisionSelect(doc, offered) {
    const selects = Array.from((doc || document).querySelectorAll('select'));
    return selects.find(function (s) {
      return Array.from(s.options).some(function (o) { return o.value === (offered || '1/16'); });
    });
  }

  function findKeySelect(doc) {
    const selects = Array.from((doc || document).querySelectorAll('select'));
    return selects.find(function (s) { return s.options.length === 12 && s.options[0].textContent === 'C'; });
  }

  function chooseOption(select, value) {
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }

  function savedShell(m) {
    try { return JSON.parse(m.saved().shell); } catch (e) { return null; }
  }

  function lastMessage(pred) {
    const m = mock().messages;
    for (let i = m.length - 1; i >= 0; i--) if (pred(m[i])) return m[i];
    return null;
  }

  async function probeBeforePlay() {
    const P = window.__probe;
    const M = mock();

    check('probe: state arrived before init', !window.__spy.initBeforeState.probe && M.stateAt !== null,
      'stateAt=' + M.stateAt);
    check('probe: store.load answered synchronously during init', P.loadSync === true);
    check('probe: save before load() ignored', P.saveBeforeLoadEmitted === 0, 'emitted=' + P.saveBeforeLoadEmitted);
    check('probe: save inside load callback ignored', P.saveInsideLoadEmitted === 0, 'emitted=' + P.saveInsideLoadEmitted);
    check('probe: save after load() emitted and kept in memory',
      P.saveAfterLoadEmitted === 1 && P.savedByShell && P.savedByShell.visits >= 1,
      'emitted=' + P.saveAfterLoadEmitted + ' saved=' + JSON.stringify(P.savedByShell));
    check('probe: getSubdivision at init', same(P.subdivisionAtInit, { key: '1/8', stepsPerBeat: 2 }),
      JSON.stringify(P.subdivisionAtInit));

    check('probe: update() transport has no sessionId',
      same(P.transportKeys, ['beatPosition', 'isPlaying', 'tempo', 'timeSigDenominator', 'timeSigNumerator']),
      JSON.stringify(P.transportKeys));

    // First sequence the shell sent: canonical form, probe's gate.
    const first = M.messages.find(function (m) { return m.name === 'setStepSequence'; });
    const expectFirst = [
      [{ n: 60, d: 0, p: 1, v: 100 }, { n: 64, d: 0, p: 1, v: 100 }],
      [{ n: 62, d: 0, p: 1, v: 100 }],
      [],
      [{ n: 67, d: 0, p: 0.5, v: 100 }]
    ];
    check('probe: first setStepSequence is canonical', first && same(first.payload.steps, expectFirst) &&
      first.payload.durationMs === 120 && first.payload.legato === false && first.payload.stepsPerBeat === 2,
      first ? JSON.stringify(first.payload) : 'no message');
    check('probe: sendNoteOn emitted one noteOn', P.noteOnDelta === 1, 'delta=' + P.noteOnDelta);
    check('probe: held note is held in the mock', M.held().some(function (h) { return h.note === 61; }),
      JSON.stringify(M.held()));

    check('probe: util.disposeObject', same(P.dispose && P.dispose.disposeObject, { geometry: 1, material: 1, map: 1 }),
      JSON.stringify(P.dispose && P.dispose.disposeObject));
    check('probe: util.disposeGroup disposes and removes descendants',
      P.dispose && same(P.dispose.disposeGroup, { geometry: 3, material: 4, map: 2 }) &&
      P.dispose.descendantsBefore === 3 && P.dispose.childrenAfter === 0 && P.dispose.nestedChildrenAfter === 0,
      JSON.stringify(P.dispose));

    // Per-frame coalescing
    await waitFor(function () { return P.burst.state === 'done'; }, 3000);
    check('probe: three setStepSequence calls in one frame make one message', P.burst.delta === 1,
      'delta=' + P.burst.delta + ' state=' + P.burst.state);
    check('probe: last write wins', same(P.burst.lastSteps, [[53], [55], [57]]), JSON.stringify(P.burst.lastSteps));
    check('probe: sendNote is one midi message of type note', P.sendNoteDelta === 1, 'delta=' + P.sendNoteDelta);
    const noteMsg = lastMessage(function (m) { return m.name === 'midi' && m.payload.type === 'note'; });
    check('probe: sendNote carries durationMs and arguments',
      noteMsg && noteMsg.payload.note === 64 && noteMsg.payload.velocity === 90 &&
      noteMsg.payload.channel === 1 && noteMsg.payload.durationMs === 120,
      noteMsg ? JSON.stringify(noteMsg.payload) : 'no message');

    // Pointer
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    const cx = r.left + 120, cy = r.top + 80;
    const P0 = P.pointer.length;
    const pe = function (type, init) {
      canvas.dispatchEvent(new PointerEvent(type, Object.assign(
        { clientX: cx, clientY: cy, pointerId: 7, bubbles: true, cancelable: true }, init)));
    };
    pe('pointermove', { buttons: 0 });
    pe('pointerdown', { button: 0, buttons: 1 });
    pe('pointermove', { buttons: 1 });
    pe('pointerup', { button: 0, buttons: 0 });
    pe('pointercancel', {});
    pe('pointerdown', { button: 2, buttons: 2 });
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: cx, clientY: cy, bubbles: true }));
    const got = P.pointer.slice(P0);
    const hooks = got.map(function (g) { return g.hook; });
    check('probe: pointer hooks delivered in order, hover included',
      same(hooks, ['onPointerMove', 'onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onPointerDown', 'onDoubleClick']),
      JSON.stringify(hooks));
    check('probe: pointer coordinates are world coordinates (origin bottom-left)',
      got.length > 0 && got.every(function (g) { return g.x === 120 && Math.abs(g.y - (r.height - 80)) < 1e-9; }),
      JSON.stringify(got[0]) + ' height=' + r.height);
    check('probe: every button passes through', got[1] && got[1].button === 0 && got[5] && got[5].button === 2,
      got[1] && got[5] ? got[1].button + ',' + got[5].button : 'missing');
    check('probe: setCursor sets the canvas cursor', canvas.style.cursor === 'crosshair', canvas.style.cursor);

    // Subdivision
    const sel = findSubdivisionSelect();
    check('probe: subdivision selector shown for a quantized experiment', !!sel && sel.style.display !== 'none');
    if (sel) {
      const tagBefore = stats().tag;
      sel.value = '1/16';
      sel.dispatchEvent(new Event('change'));
      // The resend goes out at the end of the next frame.
      await waitFor(function () { return M.lastSequence && M.lastSequence.stepsPerBeat === 4; }, 2000);
      const last = window.__probe.subChanges[window.__probe.subChanges.length - 1];
      check('probe: onSubdivisionChange fired with { key, stepsPerBeat }',
        last && last.key === '1/16' && last.stepsPerBeat === 4, JSON.stringify(last));
      check('probe: getStepIndex() is -1 after a subdivision change', last && last.stepIndex === -1,
        last && last.stepIndex);
      check('probe: subdivision change resends the sequence at the new rate, same tag',
        M.lastSequence && M.lastSequence.stepsPerBeat === 4 && M.lastSequence.tag === tagBefore,
        M.lastSequence ? 'spb=' + M.lastSequence.stepsPerBeat + ' tag=' + M.lastSequence.tag + ' shellTag=' + tagBefore : 'none');
      let shellSaved = null;
      try { shellSaved = JSON.parse(M.saved().shell); } catch (e) { /* reported below */ }
      check('probe: shell state saved with the new subdivision', shellSaved && shellSaved.subdivision === '1/16',
        JSON.stringify(shellSaved));
    }
  }

  // A scale listener that throws must not keep the listeners behind it, or the
  // shell-state save, from running; the error is reported, not lost.
  function probeScaleListeners() {
    const P = window.__probe;
    const M = mock();
    const keySelect = findKeySelect();
    const errorsBefore = M.errors.length;
    const callsBefore = P.scaleCalls.length;

    P.armScaleThrow = true;
    chooseOption(keySelect, '5');
    P.armScaleThrow = false;

    const last = P.scaleCalls[P.scaleCalls.length - 1];
    check('scale: a throwing listener does not stop the one after it',
      P.scaleThrows === 1 && P.scaleCalls.length === callsBefore + 1 && last && last.root === 'F',
      'throws=' + P.scaleThrows + ' calls=' + (P.scaleCalls.length - callsBefore) + ' last=' + JSON.stringify(last));
    const shell = savedShell(M);
    check('scale: the key change is still saved', shell && shell.root === 5, JSON.stringify(shell));
    const reported = M.errors.slice(errorsBefore);
    check('scale: the thrown error is reported through the shell',
      reported.length === 1 && reported[0].indexOf('probe scale listener') !== -1, reported.join(' | '));
    // That one report was the point of the test; the later no-errors checks start clean.
    M.errors.splice(errorsBefore);

    chooseOption(keySelect, '0');
  }

  async function probeAfterPlay() {
    const P = window.__probe;
    check('probe: step() called while playing', P.stepCalls > 0, 'calls=' + P.stepCalls);
    check('probe: step() always gets played as an array', P.playedAlwaysArray && P.lastStep && Array.isArray(P.lastStep.played),
      JSON.stringify(P.lastStep));
    check('probe: step() sometimes gets notes that fired', P.sawNonEmptyPlayed);
    check('probe: getStepIndex() equals the index passed to step()', P.stepIndexMatches);
    const idx = P.stepIndices;
    let consecutive = idx.length > 1;
    for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1] + 1) consecutive = false;
    check('probe: step indices arrive consecutively, none skipped or repeated', consecutive,
      idx.length + ' calls, first ' + idx[0] + ' last ' + idx[idx.length - 1]);
    // getStepIndex() is -1 once the transport has stopped
    mock().stop();
    await waitFor(function () { return P.ctx.getStepIndex() === -1; }, 2000);
    check('probe: getStepIndex() is -1 after the transport stops', P.ctx.getStepIndex() === -1, P.ctx.getStepIndex());
    mock().play();
  }

  async function probeSwitchAway() {
    const P = window.__probe;
    const M = mock();
    const canvas = document.getElementById('canvas');
    const noteOff61 = M.messages.some(function (m) {
      return m.name === 'midi' && m.payload.type === 'noteOff' && m.payload.note === 61;
    });
    check('probe: switching away released the held note', noteOff61 && !M.held().some(function (h) { return h.note === 61; }),
      JSON.stringify(M.held()));
    check('probe: an inactive handle stays silent', P.staleHandleDelta === 0, 'delta=' + P.staleHandleDelta);
    check('probe: cursor reset on deactivation', canvas.style.cursor === '', JSON.stringify(canvas.style.cursor));
    check('probe: pause() called once', P.pauses === 1, 'pauses=' + P.pauses);

    // The sequence the probe stored through its handle while paused is kept,
    // not sent: the sequencer belongs to the active experiment.
    const sent = M.lastSequence;
    check('probe: a paused experiment\'s setStepSequence is not sent while it is paused',
      sent && sent.tag === stats().tag && sent.steps.length === 0 && sent.stepsPerBeat === 0.5,
      sent ? JSON.stringify(sent) : 'none');
    const sel = findSubdivisionSelect(document, '1/4');
    const shell = savedShell(M);
    check('subdivision: an experiment whose list lacks the current rate gets one it offers',
      sel && sel.value === '1/2' && Array.from(sel.options).every(function (o) { return o.value !== '1/16'; }),
      sel ? sel.value : 'no selector');
    check('subdivision: the rate the probe last used is kept while probe-b is active',
      shell && shell.subdivision === '1/2' && shell.subdivisions && shell.subdivisions.probe === '1/16' &&
      shell.subdivisions['probe-b'] === '1/2' && shell.experiment === 'probe-b',
      JSON.stringify(shell));
  }

  async function probeSwitchBack(tag0) {
    const P = window.__probe;
    const M = mock();
    const seq = M.lastSequence;
    check('probe: resume() called once', P.resumes === 1, 'resumes=' + P.resumes);
    check('probe: tag incremented by each activation', stats().tag === tag0 + 2 && seq && seq.tag === tag0 + 2,
      'tag0=' + tag0 + ' shell=' + stats().tag + ' sent=' + (seq && seq.tag));
    check('probe: resuming hands over the sequence stored while paused, gate and legato included',
      seq && same(seq.steps.map(function (s) { return s.map(function (n) { return n.n; }); }), P.pausedWrite.steps) &&
      seq.durationMs === P.pausedWrite.durationMs && seq.legato === P.pausedWrite.legato,
      seq ? JSON.stringify(seq) : 'none');
    check('probe: getSubdivision on resume', P.subdivisionAtResume && P.subdivisionAtResume.key === '1/16',
      JSON.stringify(P.subdivisionAtResume));
    const sel = findSubdivisionSelect();
    const shell = savedShell(M);
    check('subdivision: switching away and back restores the experiment\'s own rate',
      sel && sel.value === '1/16' && seq && seq.stepsPerBeat === 4 &&
      shell && shell.subdivision === '1/16' && shell.subdivisions && shell.subdivisions.probe === '1/16' &&
      shell.subdivisions['probe-b'] === '1/2' && shell.experiment === 'probe',
      (sel ? sel.value : 'no selector') + ' spb=' + (seq && seq.stepsPerBeat) + ' ' + JSON.stringify(shell));
    check('subdivision: restoring a rate on activation does not call onSubdivisionChange',
      same(P.subChanges.map(function (c) { return c.key; }), ['1/16']),
      JSON.stringify(P.subChanges));
  }

  // ----------------------------------------------------------------------
  // Saved shell state planted before the page loads: each case opens a
  // throwaway copy of the harness in an iframe whose mock starts from the
  // given project state (seed=) and the sequence C++ is "already playing".
  // ----------------------------------------------------------------------
  const PLAYING = {
    steps: [[{ n: 60, d: 0, p: 1, v: 100 }], [{ n: 64, d: 0, p: 1, v: 100 }]],
    stepsPerBeat: 2, durationMs: 150, legato: false, tag: 4242
  };

  async function openSeeded(shell, sequence, quiet) {
    const q = new URLSearchParams({ probe: '1', panel: '0', seed: JSON.stringify({ web: { shell: JSON.stringify(shell) }, sequence }) });
    if (quiet) q.set('probeQuiet', '1');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed; left:0; top:0; width:900px; height:600px; border:0;' +
      'opacity:0; pointer-events:none; z-index:-1;';
    frame.src = location.pathname + '?' + q.toString();
    document.body.appendChild(frame);
    const ready = await waitFor(function () {
      try { return frame.contentWindow.Shell.getStats().booted && frame.contentWindow.Shell.getStats().activeId !== null; }
      catch (e) { return false; }
    }, 15000);
    await sleep(500);
    return { frame, win: frame.contentWindow, ready };
  }

  const sentSequences = function (win) { return win.__mock.counts.setStepSequence || 0; };

  // The saved experiment is not registered: it is shown as the first one, and
  // the sequence C++ is playing stays until something hands the sequencer over.
  async function unregisteredExperimentPass() {
    const saved = { root: 2, scaleName: 'dorian', octave: 3, subdivision: '1bar', subdivisions: { ghost: '1bar' }, experiment: 'ghost' };

    // Left alone until the user switches experiment.
    let page = await openSeeded(saved, PLAYING, true);
    let w = page.win;
    if (!page.ready) { check('unregistered experiment: page booted', false, 'no boot'); page.frame.remove(); return; }
    check('unregistered experiment: the first experiment is shown',
      w.Shell.getStats().activeId === 'probe', w.Shell.getStats().activeId);
    check('unregistered experiment: nothing is sent to the sequencer at boot',
      sentSequences(w) === 0 && same(w.__mock.lastSequence, PLAYING),
      sentSequences(w) + ' sent, last ' + JSON.stringify(w.__mock.lastSequence));
    chooseOption(findKeySelect(w.document), '7');
    let shell = savedShell(w.__mock);
    check('unregistered experiment: a later save keeps naming it and its rate',
      shell && shell.root === 7 && shell.experiment === 'ghost' && shell.subdivisions && shell.subdivisions.ghost === '1bar',
      JSON.stringify(shell));
    w.Shell.activate('probe-b');
    await waitFor(function () { return sentSequences(w) > 0; }, 3000);
    await sleep(200);
    shell = savedShell(w.__mock);
    check('unregistered experiment: switching experiment hands the sequencer over',
      sentSequences(w) === 1 && w.__mock.lastSequence.tag === w.Shell.getStats().tag && w.__mock.lastSequence.steps.length === 0,
      sentSequences(w) + ' sent, last ' + JSON.stringify(w.__mock.lastSequence));
    check('unregistered experiment: the saved experiment is the active one once handed over',
      shell && shell.experiment === 'probe-b' && shell.subdivisions && shell.subdivisions.ghost === '1bar',
      JSON.stringify(shell));
    check('unregistered experiment: no errors', w.__mock.errors.length === 0, w.__mock.errors.join(' | '));
    page.frame.remove();

    // Or until the shown experiment stores a sequence of its own.
    page = await openSeeded(saved, PLAYING, true);
    w = page.win;
    if (!page.ready) { check('unregistered experiment: second page booted', false, 'no boot'); page.frame.remove(); return; }
    check('unregistered experiment: still untouched when nothing has stored a sequence',
      sentSequences(w) === 0 && same(w.__mock.lastSequence, PLAYING), sentSequences(w) + ' sent');
    w.__probe.ctx.midi.setStepSequence([[72]], 100, false);
    await waitFor(function () { return sentSequences(w) > 0; }, 3000);
    check('unregistered experiment: the shown experiment storing a sequence hands the sequencer over',
      sentSequences(w) === 1 && w.__mock.lastSequence.steps.length === 1 && w.__mock.lastSequence.steps[0][0].n === 72 &&
      w.__mock.lastSequence.tag === w.Shell.getStats().tag,
      sentSequences(w) + ' sent, last ' + JSON.stringify(w.__mock.lastSequence));
    chooseOption(findKeySelect(w.document), '7');
    shell = savedShell(w.__mock);
    check('unregistered experiment: the saved experiment is the active one after that',
      shell && shell.experiment === 'probe', JSON.stringify(shell));
    page.frame.remove();
  }

  // The per-experiment rates come back from the saved state, and state saved
  // before they were kept per experiment still gives the active one its rate.
  async function savedSubdivisionPass() {
    const page = await openSeeded(
      { root: 0, scaleName: 'major', octave: 3, subdivision: '1/4', subdivisions: { probe: '1/16' }, experiment: 'probe-b' },
      null, false);
    const w = page.win;
    if (!page.ready) { check('saved subdivisions: page booted', false, 'no boot'); page.frame.remove(); return; }
    const selector = function () { return findSubdivisionSelect(w.document, '1/4'); };
    check('saved subdivisions: the active experiment starts at its saved rate',
      w.Shell.getStats().activeId === 'probe-b' && selector() && selector().value === '1/4',
      selector() ? selector().value : 'no selector');

    w.Shell.activate('probe');
    await waitFor(function () { return w.__mock.lastSequence && w.__mock.lastSequence.tag === w.Shell.getStats().tag; }, 3000);
    await sleep(200);
    check('saved subdivisions: another experiment gets the rate saved for it',
      selector() && selector().value === '1/16' && w.__probe.subdivisionAtInit.key === '1/16' &&
      w.__mock.lastSequence.stepsPerBeat === 4,
      (selector() ? selector().value : 'no selector') + ' spb=' + w.__mock.lastSequence.stepsPerBeat);

    w.Shell.activate('probe-b');
    await waitFor(function () { return w.__mock.lastSequence && w.__mock.lastSequence.tag === w.Shell.getStats().tag; }, 3000);
    await sleep(200);
    const shell = savedShell(w.__mock);
    check('saved subdivisions: the first experiment gets back the rate it had, not the fallback',
      selector() && selector().value === '1/4' && w.__mock.lastSequence.stepsPerBeat === 1 &&
      shell && shell.subdivisions && shell.subdivisions.probe === '1/16' && shell.subdivisions['probe-b'] === '1/4',
      (selector() ? selector().value : 'no selector') + ' ' + JSON.stringify(shell));
    check('saved subdivisions: no errors', w.__mock.errors.length === 0, w.__mock.errors.join(' | '));
    page.frame.remove();
  }

  // ----------------------------------------------------------------------
  // State-first boot
  // ----------------------------------------------------------------------
  const DELAYED_STATE_MS = 1500;

  // The page may send pageLoaded (and report errors) before the saved state
  // has arrived, nothing else: C++ is playing the saved sequence meanwhile.
  function checkStateFirst() {
    const M = mock();
    const early = M.messages.filter(function (m) {
      return !m.afterState && m.name !== 'pageLoaded' && m.name !== 'jsError';
    });
    check('nothing but pageLoaded was sent before the state arrived', early.length === 0,
      early.slice(0, 5).map(function (m) { return m.name + '@' + m.t.toFixed(0) + 'ms'; }).join(', '));

    if (M.stateDelayMs > 0) {
      // With the state held back, the experiment scripts have long finished
      // loading when it arrives, so a shell that activated experiments as
      // soon as its scripts were in would already have sent something.
      check('experiments were registered before the delayed state arrived',
        M.idsAtState && M.idsAtState.length > 0, JSON.stringify(M.idsAtState));
      check('state was held back for stateDelay=' + M.stateDelayMs + 'ms',
        M.stateAt !== null && M.stateAt >= M.stateDelayMs, 'stateAt=' + M.stateAt);
      const firstSeq = M.messages.find(function (m) { return m.name === 'setStepSequence'; });
      check('first setStepSequence came after the delayed state',
        !!firstSeq && M.stateAt !== null && firstSeq.t > M.stateAt,
        firstSeq ? 'sequence@' + firstSeq.t.toFixed(0) + 'ms state@' + (M.stateAt && M.stateAt.toFixed(0)) + 'ms' : 'none sent');
    }
  }

  // Runs this same test again in an iframe whose mock answers pageLoaded
  // late, and folds the outcome into this page's result.
  async function delayedStatePass() {
    const q = new URLSearchParams(location.search);
    q.set('stateDelay', String(DELAYED_STATE_MS));
    q.set('panel', '0');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed; left:0; top:0; width:900px; height:600px; border:0;' +
      'opacity:0; pointer-events:none; z-index:-1;';
    frame.src = location.pathname + '?' + q.toString();
    document.body.appendChild(frame);
    const done = await waitFor(function () {
      try { return !!frame.contentWindow.__autotest; } catch (e) { return false; }
    }, 40000);
    let result = null;
    try { result = frame.contentWindow.__autotest; } catch (e) { /* reported below */ }
    frame.remove();
    if (!done || !result) {
      check('delayed-state pass (stateDelay=' + DELAYED_STATE_MS + ') finished', false, 'no result from the iframe');
      return;
    }
    const failed = result.checks.filter(function (c) { return !c.pass; });
    check('delayed-state pass (stateDelay=' + DELAYED_STATE_MS + '): ' + result.checks.length + ' checks',
      result.pass, failed.map(function (c) { return c.name + ' [' + c.detail + ']'; }).join(' | '));
  }

  // ----------------------------------------------------------------------
  // Main
  // ----------------------------------------------------------------------
  async function run() {
    const M = mock();
    if (!M) { check('mock-juce loaded', false, 'window.__mock missing'); return; }

    const booted = await waitFor(function () { return stats().booted && stats().activeId !== null; }, 8000);
    const s0 = stats();
    check('an experiment is registered', s0.ids.length > 0, s0.ids.join(','));
    check('boot completed with an active experiment', booted, JSON.stringify(s0));
    if (!booted) return;

    check('pageLoaded is the first message the page sends', M.messages.length > 0 && M.messages[0].name === 'pageLoaded' &&
      M.counts.pageLoaded === 1, M.messages[0] && M.messages[0].name);
    check('no experiment was initialised before the state arrived',
      Object.keys(window.__spy.initBeforeState).length === 0, JSON.stringify(window.__spy.initBeforeState));
    check('experiment sequence handed to the sequencer after activation',
      await waitFor(function () { return M.counts.setStepSequence >= 1; }, 6000) &&
      Number.isInteger(M.lastSequence.tag), M.lastSequence ? 'tag=' + M.lastSequence.tag : 'none');
    checkStateFirst();

    const f0 = stats().frames;
    await sleep(300);
    check('frames are rendering', stats().frames - f0 > 5, 'frames=' + (stats().frames - f0) + ' in 300ms, page ' + document.visibilityState);

    const isProbe = params.get('probe') === '1' && s0.ids.indexOf('probe') !== -1;
    if (isProbe) {
      window.Shell.activate('probe');
      await probeBeforePlay();
      probeScaleListeners();
    }

    // Play at 240 bpm.
    const active = stats().activeId;
    await playFor(2000);
    if (window.__spy.hasStep[active]) {
      check('step() was called on the active experiment (' + active + ')', window.__spy.stepCalls[active] > 0,
        'calls=' + window.__spy.stepCalls[active]);
    } else {
      check('active experiment (' + active + ') does not define step(); nothing to check', true);
    }
    if (isProbe) await probeAfterPlay();

    // Switch through every other experiment and back (pause / resume).
    const ids = stats().ids;
    const origin = stats().activeId;
    if (ids.length > 1) {
      const errorsBefore = M.errors.length;
      const tag0 = stats().tag;
      for (const id of ids) {
        if (id === origin) continue;
        await activateAndSettle(id);
        check('switched to ' + id, stats().activeId === id, stats().activeId);
        if (isProbe && origin === 'probe' && id === 'probe-b') await probeSwitchAway();
      }
      await activateAndSettle(origin);
      check('switched back to ' + origin, stats().activeId === origin, stats().activeId);
      if (isProbe && origin === 'probe') await probeSwitchBack(tag0);
      check('no errors while switching experiments', M.errors.length === errorsBefore,
        M.errors.slice(errorsBefore).join(' | '));
    } else {
      check('only one experiment loaded; switching skipped', true);
    }

    M.stop();
    await sleep(500);
    // A gated note (type `note`) ends on its own after durationMs, so an
    // experiment that keeps playing immediate notes regardless of the
    // transport legitimately has some in flight; a stuck note is a noteOn
    // nobody turned off.
    const stuck = M.held().filter(function (h) { return !h.gated; });
    check('no stuck notes 500 ms after stop', stuck.length === 0,
      'held=' + JSON.stringify(M.held()));

    check('no uncaught errors', M.errors.length === 0, M.errors.slice(0, 5).join(' | '));
    check('no contract violations', M.violations.length === 0, M.violations.slice(0, 5).join(' | '));

    if (isProbe && window.parent === window) {
      await unregisteredExperimentPass();
      await savedSubdivisionPass();
    }

    if (!params.has('stateDelay') && window.parent === window) await delayedStatePass();
  }

  run().catch(function (e) {
    check('autotest ran to completion', false, e && (e.stack || e.message || e));
  }).then(finish);
})();
