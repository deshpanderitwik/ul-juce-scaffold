# ul-juce-scaffold

A JUCE 8 VST3 plugin (macOS, used in Ableton Live) that generates MIDI. A Three.js scene runs in an embedded web view; what happens in the scene becomes MIDI notes on the plugin's output. The plugin has no audio output: the owner routes the MIDI to a synth on another track.

- **C++ layer, `src/` (rarely changes).** `PluginProcessor` (audio thread, transport, saved state), `StepSequencer` (sample-accurate step sequencer), `NoteScheduler` (immediate notes and their lengths), `Bridge` (every JSON shape crossing the web view boundary, plus the saved-state format), `PluginEditor` (hosts the web view, serves `web/`).
- **Web layer, `web/` (where the creative work happens).** `shell.js` owns the renderer, the animation loop, input, the key/scale system, the top bar and the bridge. Each experiment is one file in `web/` that calls `Shell.register({...})`.
- The C++ sequencer keeps playing the last sequence it was given when the plugin window is closed, and that sequence is saved in the DAW project. The page is a view and an editor of that sequence, not the player.
- `sketches/` and `experiments/` are standalone side work, not part of the plugin. Leave them alone unless asked.

## Experiment contract

Read `web/shell.js` (`buildContext`, `activate`, `makeMidiHandle`, `makeStore`, pointer section) for the truth and `web/dev/probe.js` for a small experiment that uses every hook. The experiment's `id` must match its filename (`graph.js` registers `'graph'`).

```
Shell.register({
  id, name, description, showOctave?, subdivisions?,
  init(ctx), update(delta, transport),
  step?(stepIndex, played),
  onSubdivisionChange?(sub),
  pause?(), resume?(), destroy?(),
  onPointerDown?(p, e), onPointerMove?(p, e), onPointerUp?(p, e), onPointerCancel?(p, e), onDoubleClick?(p, e)
})
```

Metadata
- `showOctave: false` hides the octave picker (for experiments that span a fixed range).
- `subdivisions: ['1/4', '1/8', ...]` is the list the subdivision selector offers. Default `['1/4', '1/8', '1/8T', '1/16']`. Keys: `1bar` (one step per 4/4 bar), `1/2`, `1/4`, `1/8`, `1/8T`, `1/16`.
- The subdivision selector appears only for experiments that define `step`. The sequence sent to C++ always uses the shell's current subdivision, selector visible or not.

Hooks
- `init(ctx)`: once, on the experiment's first activation. Nothing is initialised until the saved state has arrived (see below), and only the active experiment is initialised; the others wait until selected.
- `update(delta, transport)`: every frame while active. `delta` is seconds.
- `step(stepIndex, played)`: for each step boundary the C++ sequencer reports while the transport plays. `stepIndex` is absolute and can be negative (count-in): index a cycle with `((i % n) + n) % n`. `played` is the array of MIDI notes that actually fired at that step, after the probability dice (empty array for a silent or fully skipped step). Several steps can arrive in one frame, in order. Defining `step` also makes the shell ease `ctx.scene.userData.dimFactor` between 0.3 (stopped) and 1 (playing); apply it to colours.
- `onSubdivisionChange({ key, stepsPerBeat })`: the user changed the subdivision while this experiment was active. The shell remembers the subdivision each experiment last used. On activation it uses the experiment's remembered value if its `subdivisions` list offers it, otherwise keeps the current value if offered, otherwise picks `1/8` (or the list's first entry). Activation changes it without this call, so read `ctx.getSubdivision()` in `init()` and `resume()` too.
- `pause()`: another experiment became active. Reset in-progress interaction (drags, hovers, presses) and your own "is this note on" bookkeeping. `resume()`: this experiment is active again. `destroy()`: the shell never calls it when switching; a paused experiment stays loaded. Use it to unsubscribe.
- Pointer hooks: see Input.

Input (the shell owns it)
- The shell listens on the canvas once and calls the pointer hooks of the active experiment only. `p = { x, y }` is in world coordinates: origin bottom-left, same space as mesh positions, one unit per CSS pixel. `e` is the original event (`e.button`, `e.shiftKey`, `e.pointerId`, ...).
- The shell captures the pointer on pointerdown, so drags keep reporting over the top bar and outside the canvas. Hover moves (no button) are delivered too.
- An experiment must not add or remove DOM listeners, call `setPointerCapture`, or convert client coordinates. The top bar overlays the top of the canvas (leave about 50 units).
- `ctx.setCursor(css)` sets the cursor; the shell clears it on deactivation.

MIDI (`ctx.midi`, this experiment's own handle)
- `sendNoteOn(note, velocity, channel)`, `sendNoteOff(note, channel)`: inert while the experiment is not active. Notes still on when the experiment is deactivated (or the window closes) are released by the shell.
- `sendNote(note, velocity, channel, durationMs)`: inert while the experiment is not active. The length is timed in C++. Never use `setTimeout` for note lengths.
- `setStepSequence(steps, durationMs, legato)`: stores THIS experiment's sequence, also while the experiment is paused (it is only sent while the experiment is active). A step is a note or an array of notes (empty array = silent step). A note is a MIDI number or `{ n, d, p, v }`: `d` delay as a fraction of a step (0-0.99), `p` probability (0-1, rolled fresh every pass), `v` velocity (1-127). `durationMs` is the gate, capped at one step; `legato: true` sustains across boundaries and sends only the chord difference. Limits: 256 steps, 48 notes per step; an oversized sequence is refused whole and the previous one stays.
- The shell sends the active experiment's stored sequence to C++ once per frame (last write wins), hands the sequencer over on every switch (an experiment with no stored sequence silences it), and sends whatever the experiment holds on resume. So: call `setStepSequence` whenever the sequence content changes, paused or not (an `onChange` rebuild while paused is stored and handed over on resume); do NOT clear it in `pause()` or `destroy()`, and do not re-send it in `resume()` just for the hand-over. `resume()` may still recompute and set a sequence if the experiment's own logic needs to.
- One exception to the hand-over: if the saved state names an active experiment that is not registered (shelved, or its script failed to load), the shell shows the first experiment but leaves the sequencer alone, because C++ is still playing that experiment's sequence. The hand-over happens when the user switches experiment, changes the subdivision, or the shown experiment calls `setStepSequence`. Until then the saved state keeps naming the missing experiment.

State (`ctx.store`)
- `ctx.store.save(value)` / `ctx.store.load(callback)`: per-experiment state, saved inside the DAW project. `value` is any JSON-serialisable value; it is serialised at call time. Every save marks the project modified, so save on change, not per frame.
- The shell boots state-first: nothing starts until the saved state has arrived, so `load()` calls back synchronously during `init` with the saved value or `null`.
- `save()` is ignored until this experiment's `load()` callback has RETURNED, so a save inside the callback is dropped too. This protects saved data from boot-time defaults; hand-written "restored" flags are unnecessary. An experiment that saves must call `load()` once in `init`.
- The key `'shell'` is reserved (key, scale, octave, the active experiment, `subdivision` = the active experiment's subdivision, `subdivisions` = every experiment's own). No `localStorage`, no `sessionStorage`, no session ids: they are not part of the project.
- Opening the window must not change the music. C++ keeps playing with the window closed; when the window opens, `init()` restores from the store and the shell sends the experiment's sequence. If that differs from the one already playing, the music audibly changes. From the same saved state (and the same key/scale/octave/subdivision), `init()` must produce the same sequence as before: no `Math.random()`, time or window size in the sequence unless the result is saved.

Context
- `ctx.scene`: this experiment's `THREE.Group` (add meshes here). `ctx.camera`: orthographic, origin bottom-left. `ctx.renderer`: read-only. The shell calls `renderer.render()`; experiments never call `requestAnimationFrame`.
- `ctx.scale`: `getNotesInRange(low, high)` (inclusive, in scale), `getNoteForDegree(degree, octave)` (1-based degree; degrees past the scale length wrap within the same octave), `getScaleDegree(midi)` (1-based, `null` if not in the scale), `getScaleLength()`, `getBaseOctave()`, `getNoteName(midi)`, `getKey()` -> `{ root, scaleName }`, `onChange(cb)` -> unsubscribe function. `onChange` fires on key, scale and octave changes with `{ root, scaleName, intervals, octave }`; a callback that throws is reported and does not stop the others.
- `ctx.getTransport()` -> `{ tempo, beatPosition, timeSigNumerator, timeSigDenominator, isPlaying }`. `ctx.getSize()` -> `{ width, height }` (fixed 900x600 in the plugin; there is no resize hook).
- `ctx.getSubdivision()` -> `{ key, stepsPerBeat }`. `ctx.getStepIndex()` -> the latest step index delivered, or -1. Never derive step numbers or the step rate from `transport.beatPosition`: C++ reports the steps.
- `ctx.util.disposeGroup(group)` removes and disposes every descendant of a group; `ctx.util.disposeObject(obj)` disposes one object's geometry, material(s) and texture map. Use them instead of hand-written dispose loops.

Design rules
- Scale-aware: get notes from `ctx.scale`, never hardcode note numbers, subscribe to `onChange` and rebuild.
- MIDI only: sound comes from whatever synth the owner has on the receiving track.
- Dark, minimal, clean visuals.
- An error thrown by a hook or a scale `onChange` callback is caught, logged and forwarded to the C++ log; the shell keeps running.

## Prototyping workflow

`web/test.js` is the scratchpad; all new ideas start there.

- "let's try something", "prototype this": work in `test.js`.
- "let's keep this", "package this up": duplicate `test.js` to `web/<id>.js` (the file name matches the experiment's `id`), set `id`/`name`/`description`, add the filename to `EXPERIMENT_FILES` in `shell.js`, then reset `test.js` to the template. CMake globs `web/*.js`; no other file needs an edit.
- "new idea", "start fresh": reset `test.js` to the template.
- `HIDDEN_EXPERIMENT_FILES` in `shell.js` lists shelved files that stay in `web/` but are not loaded.

Blank `test.js`:

```javascript
const TestExperiment = {
  id: 'test',
  name: 'Test',
  description: 'Prototyping scratchpad',

  _ctx: null,
  _group: null,
  _unsubscribeScale: null,

  init(ctx) {
    this._ctx = ctx;
    this._group = new THREE.Group();
    ctx.scene.add(this._group);

    this._unsubscribeScale = ctx.scale.onChange(() => this._rebuild());
    this._rebuild();
  },

  _rebuild() {
    this._ctx.util.disposeGroup(this._group);

    const notes = this._ctx.scale.getNotesInRange(48, 72);
    // Build your scene here using the notes array
  },

  update(delta, transport) {
    // Every frame: move things, check triggers
  },

  pause() {
    // Reset drags, hovers, presses and any "note is on" flags
  },

  resume() {},

  destroy() {
    if (this._unsubscribeScale) this._unsubscribeScale();
  },
};

Shell.register(TestExperiment);
```

## The bridge

Two JS-to-C++ calls carry the music: `midi` (immediate notes) and `setStepSequence` (the sequence). Also JS to C++: `pageLoaded`, `saveState`, `jsError`. C++ to JS: `state` (the saved web state, sent in reply to `pageLoaded`) and `tick` (about 60 per second: transport plus the step boundaries crossed since the last tick). `tests/fixtures/bridge/contract.json` is the normative reference for every payload and for the saved-state format; read it instead of guessing shapes. The shell tags each sequence it sends and ignores step events whose tag or rate is not current.

## Commands

```
Build plugin + tests:      cmake -B build && cmake --build build -j8
Run all tests:             ctest --test-dir build --output-on-failure
Fast sequencer tests only: cmake -S tests/core -B build-core && cmake --build build-core && ctest --test-dir build-core --output-on-failure
Check JS syntax:           node --check web/<file>.js     (there is no other JS tooling)
Browser harness:           serve the repo root (python3 -m http.server <port>) and open /web/dev.html
```

Harness query parameters: `only=<id>` (load just `<id>.js`), `all=1` (all seven experiment files, hidden ones included), `probe=1` (just `dev/probe.js`), `autotest=1` (run the self-test; the result is written to `#autotest-result` and the page title becomes `AUTOTEST PASS` or `AUTOTEST FAIL`), `panel=0` (hide the control panel), `stateDelay=<ms>` (delay the host's `state` reply), `seed=<json>` (start the mock from `{ web: { <key>: <json string> }, sequence: <setStepSequence payload C++ is already playing> | null }` instead of `sessionStorage`; a seeded page neither reads nor writes storage), `probeQuiet=1` (with `probe=1`: the probe experiment stores no sequence of its own). The self-test uses `seed` to plant saved shell state in iframes. The page is `index.html` with a mock JUCE backend (`web/dev/mock-juce.js`) that simulates the transport and the C++ sequencer, checks every message the page sends against `contract.json`, and shows Play/Stop, BPM and a violation count. The repo root must be served because the mock loads the fixture from `tests/`. `http.server` sends no cache headers, so hard-reload after editing a file or the browser may run the old one. Nothing under `web/dev/` or `web/dev.html` is bundled into the plugin. The mock keeps its saved state in the harness tab's `sessionStorage`; experiments never touch storage themselves.

CMake options:
- `SCAFFOLD_COPY_PLUGIN` (default ON): installs the VST3 into `~/Library/Audio/Plug-Ins/VST3` after each build. Pass `-DSCAFFOLD_COPY_PLUGIN=OFF` to build without touching the copy a running DAW has loaded.
- `SCAFFOLD_WEB_DEV` (default ON in Debug, OFF otherwise): the plugin serves `web/` from the source tree instead of the bundled copy. A fresh build directory needs `-DCMAKE_BUILD_TYPE=Debug` for it.
- `SCAFFOLD_BUILD_TESTS` (default ON): builds `tests/core` and `tests/plugin`.

Options are cached per build directory: `grep SCAFFOLD_ build/CMakeCache.txt` shows what the existing one uses (for instance, whether a build will overwrite the installed plugin).

## Workflow facts

- A Debug build serves `web/` from disk, so a JS-only change needs just the reload button (the circular arrow) in the plugin's top bar.
- A C++ change needs the build AND the plugin device re-added in Ableton (or Ableton restarted). The reload button does not reload the binary, and a stale binary typically shows up as silent or garbage MIDI.
- After an Xcode / macOS SDK update the build can fail with "'cstring' file not found" or "no such sysroot directory". Fix it without wiping the build directory:
  ```
  rm -rf build/_deps/juce-build/tools ; cmake -U 'juce_found_*' -S . -B build -DCMAKE_OSX_SYSROOT="$(xcrun --show-sdk-path)" ; cmake --build build -j8
  ```
- Nobody can hear the plugin from a terminal. C++ behaviour is checked with the tests, web behaviour with the harness, and anything about how it sounds in Live has to be checked by the owner. Say which of the three a claim rests on.

## Key rules

- Do not change the C++ layer unless asked.
- Audio-thread code (`StepSequencer`, `NoteScheduler`, `processBlock`) must not allocate, lock or do I/O.
- A change to a bridge message means changing `tests/fixtures/bridge/contract.json`, `src/Bridge.cpp` and `web/dev/mock-juce.js` together.
- Comments say why the code is the way it is, not what changed.
