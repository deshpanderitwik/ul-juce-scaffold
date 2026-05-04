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
  // JUCE bridge — transport state
  // ========================================================================
  let backendReady = false;

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

  // ========================================================================
  // JUCE bridge — MIDI API (immediate / unquantized)
  // ========================================================================
  const midi = {
    _seqNotes: null,
    _seqDurationMs: 150,

    sendNoteOn(note, velocity, channel) {
      if (!backendReady) return;
      window.__JUCE__.backend.emitEvent('sendMidiEvent', {
        type: 'noteOn', note, velocity, channel
      });
    },

    sendNoteOff(note, channel) {
      if (!backendReady) return;
      window.__JUCE__.backend.emitEvent('sendMidiEvent', {
        type: 'noteOff', note, velocity: 0, channel
      });
    },

    sendNote(note, velocity, channel, durationMs) {
      midi.sendNoteOn(note, velocity, channel);
      setTimeout(() => midi.sendNoteOff(note, channel), durationMs);
    },

    setStepSequence(notes, durationMs) {
      midi._seqNotes = notes;
      midi._seqDurationMs = durationMs || 150;
      midi._sendSequenceToBackend();
    },

    _sendSequenceToBackend() {
      if (!backendReady) return;
      var notes = midi._seqNotes || [];
      window.__JUCE__.backend.emitEvent('setStepSequence', {
        notes: notes,
        subdivision: SUBDIVISIONS[currentSubdivision] || 2,
        durationMs: midi._seqDurationMs
      });
    }
  };

  // ========================================================================
  // JUCE backend initialization
  // ========================================================================
  function initBackend() {
    if (typeof window.__JUCE__ === 'undefined' || !window.__JUCE__.backend) {
      setTimeout(initBackend, 50);
      return;
    }

    backendReady = true;

    window.__JUCE__.backend.addEventListener('transportState', function (data) {
      transport.tempo              = data.bpm              ?? 120.0;
      transport.beatPosition       = data.beatPosition     ?? 0.0;
      transport.timeSigNumerator   = data.timeSigNumerator ?? 4;
      transport.timeSigDenominator = data.timeSigDenominator ?? 4;
      transport.isPlaying          = data.isPlaying        ?? false;
      transport.sessionId          = data.sessionId        ?? '';
    });
  }

  initBackend();

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

  let currentRoot      = parseInt(localStorage.getItem('shell.root'), 10) || 0;
  let currentScaleName = localStorage.getItem('shell.scale') || 'major';
  if (!SCALES[currentScaleName]) currentScaleName = 'major';
  let currentOctave    = parseInt(localStorage.getItem('shell.octave'), 10);
  if (isNaN(currentOctave) || currentOctave < 0 || currentOctave > 7) currentOctave = 3;
  const scaleListeners = [];

  // ========================================================================
  // Subdivision system (for quantized experiments)
  // ========================================================================
  const SUBDIVISIONS = {
    '1/4':  1,
    '1/8':  2,
    '1/8T': 3,
    '1/16': 4,
  };

  const SUBDIVISION_DISPLAY = {
    '1/4':  '1/4',
    '1/8':  '1/8',
    '1/8T': '1/8T',
    '1/16': '1/16',
  };

  let currentSubdivision = localStorage.getItem('shell.subdivision') || '1/8';
  if (!SUBDIVISIONS[currentSubdivision]) currentSubdivision = '1/8';
  let lastStepIndex = -1;

  function notifyScaleChange() {
    localStorage.setItem('shell.root', currentRoot);
    localStorage.setItem('shell.scale', currentScaleName);
    localStorage.setItem('shell.octave', currentOctave);
    const info = {
      root:      ROOT_NAMES[currentRoot],
      scaleName: currentScaleName,
      intervals: SCALES[currentScaleName],
      octave:    currentOctave
    };
    for (const cb of scaleListeners) cb(info);
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
  const EXPERIMENT_FILES = ['test.js', 'scribbler.js', 'graph.js'];

  // ========================================================================
  // Experiment lifecycle
  // ========================================================================
  const experiments = new Map();   // id → { experiment, group, initialized }
  let activeId = null;

  function buildContext(group) {
    return {
      scene:        group,       // THREE.Group — experiment adds meshes here
      camera,                    // read-only reference
      renderer,                  // read-only reference
      midi,
      scale,
      getTransport,
      getSize
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
    experiments.set(id, {
      experiment,
      group:       new THREE.Group(),
      initialized: false
    });

    // Append to the experiment selector dropdown
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = experiment.name;
    experimentSelect.appendChild(opt);

    updateSelector();
  }

  function activate(id) {
    if (!experiments.has(id)) return;
    if (activeId === id) return;

    // Pause the current experiment
    if (activeId !== null) {
      const current = experiments.get(activeId);
      scene.remove(current.group);
      if (current.experiment.pause) current.experiment.pause();
    }

    // Activate the new experiment
    const entry = experiments.get(id);
    activeId = id;
    localStorage.setItem('shell.experiment', id);
    scene.add(entry.group);

    if (!entry.initialized) {
      entry.initialized = true;
      entry.experiment.init(buildContext(entry.group));
    } else {
      if (entry.experiment.resume) entry.experiment.resume();
    }

    // Show/hide subdivision selector based on whether experiment is quantized
    var isQuantized = typeof entry.experiment.step === 'function';
    divider2.style.display = isQuantized ? '' : 'none';
    subdivisionSelect.style.display = isQuantized ? '' : 'none';
    lastStepIndex = -1;

    updateSelector();
  }

  // Expose to global scope so experiment scripts can call Shell.register()
  window.Shell = { register, activate };

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
  subdivisionSelect.style.display = 'none';
  subdivisionSelect.style.cssText = selectStyle;
  var subdivKeys = Object.keys(SUBDIVISIONS);
  for (var sdi = 0; sdi < subdivKeys.length; sdi++) {
    var opt = document.createElement('option');
    opt.value = subdivKeys[sdi];
    opt.textContent = SUBDIVISION_DISPLAY[subdivKeys[sdi]];
    if (subdivKeys[sdi] === currentSubdivision) opt.selected = true;
    subdivisionSelect.appendChild(opt);
  }
  subdivisionSelect.addEventListener('change', function () {
    currentSubdivision = subdivisionSelect.value;
    localStorage.setItem('shell.subdivision', currentSubdivision);
    lastStepIndex = -1;
    midi._sendSequenceToBackend();
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
  // Animation loop
  // ========================================================================
  const clock = new THREE.Clock();

  // When the page is backgrounded, rAF pauses but the clock keeps ticking.
  // Drain the accumulated delta on return so experiments don't get a huge
  // time step that jolts resting physics bodies into false collisions.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) clock.getDelta();
  });

  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    const tp    = getTransport();

    // Quantized step detection + transport dimming
    if (activeId !== null) {
      const entry = experiments.get(activeId);
      if (typeof entry.experiment.step === 'function') {
        var dimTarget = tp.isPlaying ? 1.0 : 0.3;
        var current   = entry.group.userData.dimFactor ?? 1.0;
        var next      = current + (dimTarget - current) * Math.min(1, delta * 8);
        entry.group.userData.dimFactor = next;

        if (tp.isPlaying) {
          const multiplier = SUBDIVISIONS[currentSubdivision] || 2;
          const currentStep = Math.floor(tp.beatPosition * multiplier);
          if (currentStep !== lastStepIndex) {
            lastStepIndex = currentStep;
            entry.experiment.step(currentStep);
          }
        } else {
          lastStepIndex = -1;
        }
      }
    }

    // Update the active experiment
    if (activeId !== null) {
      const entry = experiments.get(activeId);
      if (entry.experiment.update) {
        entry.experiment.update(delta, tp);
      }
    }

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
    let chain = Promise.resolve();
    for (const file of EXPERIMENT_FILES) {
      chain = chain.then(() => loadScript(file));
    }
    chain.then(() => {
      if (experiments.size === 0 || activeId !== null) return;
      const saved = localStorage.getItem('shell.experiment');
      const id = (saved && experiments.has(saved)) ? saved : experiments.keys().next().value;
      activate(id);
    });
  })();

})();
