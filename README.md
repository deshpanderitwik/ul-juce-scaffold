# ul-juce-scaffold

A scaffold for building **JUCE MIDI sequencer plugins with web-based front ends**. The C++ layer is a thin VST3 host that exposes a transport, a lock-free MIDI queue, and a sample-accurate step sequencer that plays on its own; the front end is an embedded WebView where all the creative work happens. Designed as a stable shell for hosting a variety of sequencer experiments without having to touch C++ each time.

## What it does

- **VST3 instrument plugin** (JUCE 8). Outputs MIDI only, silent on audio out. Route MIDI to any synth.
- **Embedded web view** via JUCE's `WebBrowserComponent`. `web/` files are bundled as binary resources at build time; Debug builds serve them straight from the source tree instead.
- **Step sequencer in C++**: sample-accurate, beat-aligned, handles loops and scrubs. The web page hands it a sequence (notes, chords, per-note delay, probability and velocity); it plays on the audio thread and reports each step back to the page.
- **Plays with the window closed.** The last sequence is saved in the DAW project together with each experiment's state, and is restored into the audio thread when the project loads. The editor does not have to be opened for a project to sound.
- **Immediate notes**: `sendNoteOn` / `sendNoteOff` / `sendNote` calls cross the bridge into a lock-free queue; note lengths and held notes are tracked on the audio thread, so a closed or reloaded page cannot leave a note stuck.
- **Transport mirror**: BPM, ppq beat position, play state and time signature are read from the host playhead and sent to the page about 60 times a second.

## Architecture

```
DAW ──► PluginProcessor (audio thread) ──► MIDI out
            │   ▲                              ▲
            │   │ sequence, immediate notes    │ StepSequencer, NoteScheduler
            │   │ saved state                  │
            ▼   │                              │
        PluginEditor ◄── Bridge (JSON) ──► shell.js ◄──► experiment.js
        (WebBrowserComponent)              (Three.js render loop, input,
                                            scale system, experiment lifecycle)
```

C++ (`src/`, rarely changes):

- **`PluginProcessor.{h,cpp}`**: transport state (atomics), the hand-off of sequences and immediate notes from the message thread to the audio thread, and the saved project state (web state plus the last sequence). Audio-thread code never allocates, locks or does I/O.
- **`StepSequencer.{h,cpp}`**: the sample-accurate step sequencer. No JUCE dependency, so it is tested on its own. It reports every step boundary it crosses (index, which notes passed the probability dice) so the page can follow the audio.
- **`NoteScheduler.{h,cpp}`**: immediate notes sent from the page, with their lengths and held state kept on the audio thread. No JUCE dependency.
- **`Bridge.{h,cpp}`**: the one place that knows the JSON shapes crossing between the web view and C++, and the format of the saved state. [tests/fixtures/bridge/contract.json](tests/fixtures/bridge/contract.json) holds canonical examples of every message; the C++ parsers and the browser harness are both checked against it.
- **`PluginEditor.{h,cpp}`**: hosts the WebView, serves the web assets, wires bridge events to the processor and pushes ticks to the page.

Web (`web/`, where the creative work happens):

- **`shell.js`**: owns the Three.js renderer, the animation loop, pointer input, the key and scale system, the top bar, the bridge, and the hand-over of the step sequencer between experiments. On start-up it waits for the saved state before it initialises anything, so an experiment never starts from defaults and replaces a sequence that is already playing.
- **`<experiment>.js`**: one file per experiment (for example [graph.js](web/graph.js), [scribbler.js](web/scribbler.js)). Each registers itself with `Shell.register()`.
- **`test.js`**: the prototyping scratchpad. New ideas start here; keepers are duplicated to a named file.
- **`three.min.js`**: vendored Three.js.
- **`dev.html`, `dev/`**: the browser harness (see below). Not bundled into the plugin.

Tests (`tests/`):

- **`tests/core`**: JUCE-free tests of the step sequencer and the note scheduler. Builds on its own in a few seconds.
- **`tests/plugin`**: bridge parsing and the processor running headless, linked against the plugin's own compiled code.
- **`tests/fixtures/bridge/contract.json`**: the bridge reference both sides are checked against.

## Experiment contract

An experiment calls `Shell.register({ id, name, description, init, update, ... })`. The shell hands `init(ctx)` a context with:

- `scene`, `camera`, `renderer`: Three.js handles. `scene` is the experiment's own `THREE.Group`.
- `midi`: `sendNoteOn`, `sendNoteOff`, `sendNote(note, velocity, channel, durationMs)` and `setStepSequence(steps, durationMs, legato)`. The handle goes quiet while the experiment is not the active one.
- `scale`: key and scale aware helpers (`getNotesInRange`, `getNoteForDegree`, `getScaleDegree`, `onChange`, ...).
- `store`: `save` / `load` for per-experiment state kept in the DAW project.
- `getTransport()`, `getSize()`, `getSubdivision()`, `getStepIndex()`, `setCursor()`, and `util.disposeGroup` / `util.disposeObject` for cleaning up Three.js objects.

Optional hooks: `step(stepIndex, played)` for each step the C++ sequencer plays, `onSubdivisionChange`, `pause` / `resume` / `destroy`, and pointer hooks (`onPointerDown`, `onPointerMove`, `onPointerUp`, `onPointerCancel`, `onDoubleClick`, `onWheel`) that receive world coordinates. The shell drives `update(delta, transport)` every frame and owns the render loop and all input listeners; experiments never call `requestAnimationFrame`, `renderer.render()` or `addEventListener` for pointer input.

The full contract, with the details that are easy to get wrong, is in [CLAUDE.md](CLAUDE.md).

## Build and test

Requires CMake 3.22 or newer and a C++20 compiler. JUCE is fetched automatically.

```sh
cmake -B build && cmake --build build -j8          # plugin and tests
ctest --test-dir build --output-on-failure         # all tests

# sequencer and scheduler tests only, no JUCE
cmake -S tests/core -B build-core && cmake --build build-core && ctest --test-dir build-core --output-on-failure
```

CMake options:

- `SCAFFOLD_COPY_PLUGIN` (default ON): copies the built VST3 into `~/Library/Audio/Plug-Ins/VST3` after each build. Pass `-DSCAFFOLD_COPY_PLUGIN=OFF` to build without touching the copy a running DAW has loaded.
- `SCAFFOLD_WEB_DEV` (default ON in Debug, OFF otherwise; pass `-DCMAKE_BUILD_TYPE=Debug` in a fresh build directory): the plugin serves `web/` from the source tree, so a change to a `.js` file only needs the reload button in the plugin's top bar. A C++ change needs a rebuild and the plugin re-added in the DAW.
- `SCAFFOLD_BUILD_TESTS` (default ON): builds the test executables.

A new `.js` file under `web/` is picked up by `file(GLOB web/*.js)`; add its name to `EXPERIMENT_FILES` in `shell.js` to load it. No CMake edits are needed.

## Browser harness

The web layer runs in an ordinary browser against a mock JUCE backend that simulates the transport and the C++ step sequencer and checks every message against the bridge contract. Serve the repository root and open `/web/dev.html`:

```sh
python3 -m http.server 8000
# http://localhost:8000/web/dev.html
```

Query parameters: `only=<id>` loads one experiment, `all=1` loads every experiment file including shelved ones, `probe=1` loads a small experiment that exercises every hook, `autotest=1` runs the harness self-test and reports pass or fail in the page, `panel=0` hides the control panel.

## Status

Scaffold / experimental. The C++ layer is intentionally minimal and stable; the web layer is where new sequencer ideas get tried out. How the plugin sounds in a DAW is checked by ear; the tests and the harness cover the sequencer, the bridge and the shell.
