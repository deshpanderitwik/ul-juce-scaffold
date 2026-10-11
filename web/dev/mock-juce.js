// ==========================================================================
// mock-juce.js — stand-in for the JUCE backend, so the web layer runs in a
// normal browser. Defines window.__JUCE__ synchronously, checks every
// message the page sends against tests/fixtures/bridge/contract.json,
// simulates the transport and the C++ step sequencer, and shows a small
// control panel. Not bundled into the plugin.
// ==========================================================================

(function () {
  'use strict';

  const params = new URLSearchParams(location.search);

  const STORAGE_SAVED    = 'mock-juce.saved';
  const STORAGE_SEQUENCE = 'mock-juce.sequence';
  const FIXTURE_URL      = '../tests/fixtures/bridge/contract.json';
  const LOG_LIMIT        = 400;
  // How long the host takes to answer pageLoaded. A delay longer than the
  // time the experiment scripts need to load is what proves the page waits
  // for the saved state before it starts anything.
  const STATE_DELAY_MS   = Math.max(0, Math.min(10000, Number(params.get('stateDelay')) || 0));
  const MESSAGE_LIMIT    = 2000;

  // seed=<json> starts the page from the project state given there instead of
  // from sessionStorage: { web: { <key>: <json string> }, sequence: <the
  // setStepSequence payload C++ is already playing> | null }. A seeded page
  // neither reads nor writes sessionStorage, so the autotest can open
  // throwaway pages in iframes without disturbing the page that runs it.
  let seed = null;
  if (params.has('seed')) {
    try { seed = JSON.parse(params.get('seed')); } catch (e) { seed = null; }
    if (seed === null || typeof seed !== 'object') seed = { web: {}, sequence: null };
  }

  // An autotest run must not depend on what an earlier run left behind.
  if (seed === null && params.get('autotest') === '1') {
    try {
      sessionStorage.removeItem(STORAGE_SAVED);
      sessionStorage.removeItem(STORAGE_SEQUENCE);
    } catch (e) { /* storage unavailable: nothing to clear */ }
  }

  function storageGet(key, fallback) {
    if (seed !== null) return fallback;
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    if (seed !== null) return;
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Fixtures. Loaded synchronously: the page's first message can arrive
  // before an async fetch would have finished.
  // ------------------------------------------------------------------
  let contract = null;
  const violations = [];
  const errors = [];

  function violation(text) {
    violations.push(text);
    console.warn('[mock-juce] contract violation: ' + text);
    panelDirty = true;
  }

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', FIXTURE_URL, false);
    xhr.send(null);
    if (xhr.status !== 200) throw new Error('HTTP ' + xhr.status);
    contract = JSON.parse(xhr.responseText);
  } catch (e) {
    violations.push('contract.json could not be loaded from ' + FIXTURE_URL + ': ' + e.message);
  }

  function jsonType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  // Same keys, same JSON types as the first canonical example.
  function checkShape(where, payload, example) {
    if (jsonType(payload) !== 'object') {
      violation(where + ': payload is ' + jsonType(payload) + ', expected object');
      return false;
    }
    let ok = true;
    const want = Object.keys(example).sort();
    const have = Object.keys(payload).sort();
    if (want.join() !== have.join()) {
      violation(where + ': keys [' + have + '] differ from canonical [' + want + ']');
      ok = false;
    }
    for (const k of want) {
      if (k in payload && jsonType(payload[k]) !== jsonType(example[k])) {
        violation(where + '.' + k + ': is ' + jsonType(payload[k]) + ', canonical is ' + jsonType(example[k]));
        ok = false;
      }
    }
    return ok;
  }

  function isInt(x) { return typeof x === 'number' && Number.isInteger(x); }

  function checkMidi(p) {
    if (!['noteOn', 'noteOff', 'note', 'allNotesOff'].includes(p.type)) {
      violation('midi.type: unknown type "' + p.type + '"');
    }
    if (!isInt(p.note) || p.note < 0 || p.note > 127) violation('midi.note: ' + p.note + ' is not an integer 0-127');
    if (!isInt(p.velocity) || p.velocity < 0 || p.velocity > 127) violation('midi.velocity: ' + p.velocity + ' is not an integer 0-127');
    if ((p.type === 'noteOn' || p.type === 'note') && p.velocity < 1) violation('midi.velocity: ' + p.type + ' needs velocity 1-127');
    if (!isInt(p.channel) || p.channel < 1 || p.channel > 16) violation('midi.channel: ' + p.channel + ' is not an integer 1-16');
    if (!isInt(p.durationMs) || p.durationMs < 0) violation('midi.durationMs: ' + p.durationMs + ' is not an integer >= 0');
    if (p.type === 'note' && p.durationMs < 1) violation('midi.durationMs: a gated note needs durationMs > 0');
  }

  function checkSequence(p) {
    if (!(p.stepsPerBeat > 0)) violation('setStepSequence.stepsPerBeat: ' + p.stepsPerBeat + ' must be > 0');
    if (!(p.durationMs > 0)) violation('setStepSequence.durationMs: ' + p.durationMs + ' must be > 0');
    if (!isInt(p.tag)) violation('setStepSequence.tag: ' + p.tag + ' is not an integer');
    if (!Array.isArray(p.steps)) return;
    if (p.steps.length > 256) violation('setStepSequence.steps: ' + p.steps.length + ' steps (max 256)');
    const noteKeys = ['d', 'n', 'p', 'v'];
    p.steps.forEach(function (step, i) {
      if (!Array.isArray(step)) {
        violation('setStepSequence.steps[' + i + '] is ' + jsonType(step) + ', expected array');
        return;
      }
      if (step.length > 48) violation('setStepSequence.steps[' + i + ']: ' + step.length + ' notes (max 48)');
      step.forEach(function (note, j) {
        const where = 'setStepSequence.steps[' + i + '][' + j + ']';
        if (jsonType(note) !== 'object') { violation(where + ' is ' + jsonType(note) + ', expected object'); return; }
        if (Object.keys(note).sort().join() !== noteKeys.join()) {
          violation(where + ': keys [' + Object.keys(note).sort() + '] are not exactly n,d,p,v');
          return;
        }
        if (!isInt(note.n) || note.n < 0 || note.n > 127) violation(where + '.n: ' + note.n + ' is not an integer 0-127');
        if (typeof note.d !== 'number' || !(note.d >= 0 && note.d <= 0.99)) violation(where + '.d: ' + note.d + ' is not a number 0-0.99');
        if (typeof note.p !== 'number' || !(note.p >= 0 && note.p <= 1)) violation(where + '.p: ' + note.p + ' is not a number 0-1');
        if (!isInt(note.v) || note.v < 1 || note.v > 127) violation(where + '.v: ' + note.v + ' is not an integer 1-127');
      });
    });
  }

  // Returns the payload as the bridge would deliver it: through JSON, so
  // undefined, NaN and functions show up as the violations they would be.
  function validateFromPage(name, payload) {
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(payload === undefined ? null : payload));
    } catch (e) {
      violation(name + ': payload is not JSON-serialisable (' + e.message + ')');
      return null;
    }
    if (!contract) return clone;
    const spec = contract.jsToCpp[name];
    if (!spec) {
      violation('"' + name + '" is not a message the page may send');
      return clone;
    }
    const shapeOk = checkShape(name, clone, spec.examples[0].payload);
    if (shapeOk) {
      if (name === 'midi') checkMidi(clone);
      if (name === 'setStepSequence') checkSequence(clone);
      if (name === 'saveState' && clone.key === '') violation('saveState.key is empty');
    }
    return clone;
  }

  // The mock's own output is held to the same fixtures, so a drift between
  // mock and contract is caught here and not in the shell.
  function validateToPage(name, payload) {
    if (!contract) return;
    const spec = contract.cppToJs[name];
    if (!spec) { violation('mock sent unknown event "' + name + '"'); return; }
    const example = spec.examples[spec.examples.length > 1 ? 1 : 0].payload;
    const copy = Object.assign({}, payload);
    const steps = copy.steps;
    delete copy.steps;
    const exampleCopy = Object.assign({}, example);
    delete exampleCopy.steps;
    checkShape('mock ' + name, copy, exampleCopy);
    if (name === 'tick') {
      for (const s of steps) {
        checkShape('mock tick.steps[]', s, { i: 0, spb: 0, tag: 0, played: [] });
      }
    }
  }

  // ------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------
  const log = [];
  const messages = [];
  const counts = {};
  const t0 = performance.now();

  function logLine(text) {
    log.push(((performance.now() - t0) / 1000).toFixed(2) + ' ' + text);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    panelDirty = true;
  }

  function count(key) { counts[key] = (counts[key] || 0) + 1; }

  // ------------------------------------------------------------------
  // Backend <-> page plumbing
  // ------------------------------------------------------------------
  const listeners = {};
  let pageLoaded = false;

  function dispatch(name, payload) {
    validateToPage(name, payload);
    const cbs = listeners[name];
    if (!cbs) return;
    for (const cb of cbs.slice()) {
      try {
        cb(JSON.parse(JSON.stringify(payload)));
      } catch (e) {
        errors.push('listener for "' + name + '" threw: ' + (e && e.message));
        console.error(e);
      }
    }
  }

  let saved = seed !== null ? Object.assign({}, seed.web) : storageGet(STORAGE_SAVED, {});
  if (jsonType(saved) !== 'object') saved = {};
  let lastSequence = seed !== null ? (seed.sequence || null) : storageGet(STORAGE_SEQUENCE, null);
  let stateAt = null;          // when the `state` event was delivered
  let idsAtState = null;       // experiments registered at that moment

  // ------------------------------------------------------------------
  // Immediate MIDI: held notes and their gate timers
  // ------------------------------------------------------------------
  const heldNotes = new Map();   // "channel:note" -> { note, channel, timer }

  function releaseNote(key) {
    const h = heldNotes.get(key);
    if (!h) return;
    clearTimeout(h.timer);
    heldNotes.delete(key);
    panelDirty = true;
  }

  function releaseAll() {
    for (const key of Array.from(heldNotes.keys())) releaseNote(key);
  }

  function handleMidi(m) {
    const key = m.channel + ':' + m.note;
    count('midi:' + m.type);
    if (m.type === 'noteOn') {
      releaseNote(key);
      heldNotes.set(key, { note: m.note, channel: m.channel, timer: 0 });
      logLine('on   ' + m.note + ' v' + m.velocity + ' ch' + m.channel);
    } else if (m.type === 'noteOff') {
      releaseNote(key);
      logLine('off  ' + m.note + ' ch' + m.channel);
    } else if (m.type === 'note') {
      releaseNote(key);
      const timer = setTimeout(function () {
        heldNotes.delete(key);
        logLine('off  ' + m.note + ' ch' + m.channel + ' (gate)');
      }, m.durationMs);
      heldNotes.set(key, { note: m.note, channel: m.channel, timer });
      logLine('note ' + m.note + ' v' + m.velocity + ' ' + m.durationMs + 'ms');
    } else if (m.type === 'allNotesOff') {
      releaseAll();
      logLine('all notes off');
    }
    panelDirty = true;
  }

  function handleFromPage(name, payload) {
    const p = validateFromPage(name, payload);
    // Until `state` has been delivered the page does not know what the saved
    // project holds, and C++ is already playing the saved sequence: anything
    // the page sends but pageLoaded (and error reports) could overwrite it.
    const afterState = stateAt !== null;
    if (!afterState && name !== 'pageLoaded' && name !== 'jsError') {
      violation('"' + name + '" sent before the state event was delivered');
    }
    messages.push({ t: performance.now() - t0, name, payload: p, afterState });
    if (messages.length > MESSAGE_LIMIT) messages.splice(0, messages.length - MESSAGE_LIMIT);
    count(name);
    if (p === null || typeof p !== 'object') return;

    switch (name) {
      case 'pageLoaded':
        releaseAll();
        pageLoaded = true;
        logLine('pageLoaded');
        setTimeout(function () {
          stateAt = performance.now() - t0;
          idsAtState = window.Shell && Shell.getStats ? Shell.getStats().ids : [];
          dispatch('state', { web: Object.assign({}, saved) });
        }, STATE_DELAY_MS);
        break;
      case 'midi':
        handleMidi(p);
        break;
      case 'setStepSequence':
        lastSequence = p;
        storageSet(STORAGE_SEQUENCE, p);
        logLine('sequence ' + p.steps.length + ' steps @' + p.stepsPerBeat + '/beat tag ' + p.tag);
        break;
      case 'saveState':
        count('saveState:' + p.key);
        if (typeof p.value === 'string') {
          saved[p.key] = p.value;
          storageSet(STORAGE_SAVED, saved);
        }
        logLine('save ' + p.key);
        break;
      case 'jsError':
        errors.push('jsError: ' + p.message + ' (' + p.source + ':' + p.line + ')');
        logLine('JS ERROR ' + p.message);
        break;
    }
  }

  window.__JUCE__ = {
    backend: {
      emitEvent: function (name, payload) { handleFromPage(name, payload); },
      addEventListener: function (name, cb) {
        (listeners[name] = listeners[name] || []).push(cb);
      }
    }
  };

  // Errors that never reached the shell's own reporter (or happened before
  // it was installed).
  window.addEventListener('error', function (e) {
    errors.push('window error: ' + e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')');
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });

  // ------------------------------------------------------------------
  // Transport and sequencer simulation
  // ------------------------------------------------------------------
  let playing  = false;
  let bpm      = 120;
  let beat     = 0;           // position in quarter notes
  let lastTime = performance.now();
  let prevBeat = -1e-6;       // position at the previous tick

  function play() {
    if (playing) return;
    playing  = true;
    lastTime = performance.now();
    prevBeat = beat - 1e-6;   // a boundary exactly at the start position counts as crossed
    logLine('play @' + bpm + ' bpm');
    panelDirty = true;
  }

  function stop() {
    if (!playing) return;
    playing = false;
    logLine('stop');
    panelDirty = true;
  }

  function setBpm(n) {
    n = Number(n);
    if (!(n >= 20 && n <= 400)) return;
    bpm = n;
    panelDirty = true;
  }

  function crossedSteps(from, to) {
    const seq = lastSequence;
    if (!seq) return [];
    const spb = seq.stepsPerBeat;
    const n   = seq.steps.length;
    const out = [];
    for (let k = Math.floor(from * spb) + 1; k <= Math.floor(to * spb); k++) {
      const notes = n === 0 ? [] : seq.steps[((k % n) + n) % n];
      const played = [];
      for (const note of notes) {
        if (Math.random() < note.p) played.push(note.n);
      }
      out.push({ i: k, spb, tag: seq.tag, played });
      if (played.length) logLine('step ' + k + ' [' + played.join(',') + ']');
    }
    return out;
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!pageLoaded) return;

    const now = performance.now();
    let steps = [];
    if (playing) {
      beat += (now - lastTime) / 1000 * bpm / 60;
      steps = crossedSteps(prevBeat, beat);
      prevBeat = beat;
    }
    lastTime = now;

    dispatch('tick', {
      bpm,
      beatPosition: beat,
      isPlaying: playing,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      steps
    });
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------------
  // Control panel
  // ------------------------------------------------------------------
  let panelDirty = true;
  let panelEls = null;

  function buildPanel() {
    if (params.get('panel') === '0' || !document.body) return;

    const panel = document.createElement('div');
    panel.id = 'mock-panel';
    panel.style.cssText =
      'position:fixed; left:8px; bottom:8px; z-index:200; width:230px; padding:6px 8px;' +
      'background:rgba(0,0,0,0.55); color:#aaa; border-radius:8px; backdrop-filter:blur(6px);' +
      'font:10px/1.35 ui-monospace,Menlo,monospace; pointer-events:auto;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:4px;';

    const playBtn = document.createElement('button');
    playBtn.style.cssText =
      'padding:2px 8px; border:none; border-radius:6px; background:rgba(255,255,255,0.12);' +
      'color:#ddd; font:inherit; cursor:pointer;';
    playBtn.addEventListener('click', function () { playing ? stop() : play(); });

    const bpmInput = document.createElement('input');
    bpmInput.type = 'number';
    bpmInput.min = '20';
    bpmInput.max = '400';
    bpmInput.style.cssText =
      'width:46px; padding:2px 4px; border:none; border-radius:6px; background:rgba(255,255,255,0.12);' +
      'color:#ddd; font:inherit;';
    bpmInput.addEventListener('change', function () { setBpm(bpmInput.value); });

    const viol = document.createElement('span');
    viol.style.marginLeft = 'auto';

    row.append(playBtn, bpmInput, viol);

    const logEl = document.createElement('pre');
    logEl.style.cssText = 'margin:0; height:130px; overflow:hidden; white-space:pre; color:#888;';

    panel.append(row, logEl);
    document.body.appendChild(panel);
    panelEls = { playBtn, bpmInput, viol, logEl };
  }

  function refreshPanel() {
    requestAnimationFrame(refreshPanel);
    if (!panelEls || !panelDirty) return;
    panelDirty = false;
    panelEls.playBtn.textContent = playing ? 'Stop' : 'Play';
    if (document.activeElement !== panelEls.bpmInput) panelEls.bpmInput.value = String(bpm);
    const bad = violations.length + errors.length;
    panelEls.viol.textContent = violations.length + ' violations' + (errors.length ? ', ' + errors.length + ' err' : '');
    panelEls.viol.style.color = bad ? '#ff6b6b' : '#7c7';
    panelEls.logEl.textContent = log.slice(-12).join('\n');
  }

  if (document.body) {
    buildPanel();
  } else {
    document.addEventListener('DOMContentLoaded', buildPanel);
  }
  requestAnimationFrame(refreshPanel);

  // ------------------------------------------------------------------
  // Handle for automated checks
  // ------------------------------------------------------------------
  window.__mock = {
    log,
    violations,
    errors,
    messages,
    counts,
    held: function () {
      return Array.from(heldNotes.values()).map(function (h) { return { note: h.note, channel: h.channel, gated: h.timer !== 0 }; });
    },
    saved: function () { return Object.assign({}, saved); },
    // The host restoring plugin state while the page is open: the saved map
    // is replaced and a fresh `state` event goes out (the shell reloads).
    restoreState: function (web) {
      saved = Object.assign({}, web);
      storageSet(STORAGE_SAVED, saved);
      dispatch('state', { web: Object.assign({}, saved) });
    },
    play,
    stop,
    setBpm,
    get lastSequence() { return lastSequence; },
    get stateAt() { return stateAt; },
    get stateDelayMs() { return STATE_DELAY_MS; },
    get idsAtState() { return idsAtState; },
    get playing() { return playing; },
    get bpm() { return bpm; }
  };
})();
