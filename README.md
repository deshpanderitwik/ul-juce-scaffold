# ul-juce-scaffold

A scaffold for building **JUCE MIDI sequencer plugins with web-based front ends**. The C++ layer is a thin VST3 host that exposes a transport, a lock-free MIDI queue, and a sample-accurate step sequencer; the front end is an embedded WebView where all the creative work happens. Designed as a stable shell for hosting a variety of sequencer experiments without having to touch C++ each time.

## What it does

- **VST3 instrument plugin** (JUCE 8). Outputs MIDI only — silent on audio out. Route MIDI to any synth.
- **Embedded web view** via JUCE's `WebBrowserComponent`, with `web/` files bundled as binary resources at build time.
- **JS → C++ bridge** for MIDI: `sendNoteOn` / `sendNoteOff` / `sendNote` calls cross into a lock-free FIFO that the audio thread drains each block.
- **Step sequencer in C++** (sample-accurate, beat-aligned, handles loops/scrubs) driven by a note list pushed from JS.
- **Transport mirror**: BPM, ppq beat position, play state, time signature read from the host playhead and exposed to JS each frame.

## Architecture

```
DAW ──► PluginProcessor (audio thread) ──► MIDI out
            ▲                                ▲
            │ playhead                       │ note events
            │                                │
        WebBrowserComponent  ◄──►  shell.js  ◄──►  experiment.js
                                  (Three.js render loop, scale system,
                                   experiment lifecycle, MIDI API)
```

- **`src/PluginProcessor.{h,cpp}`** — transport state (atomics), `AbstractFifo` MIDI queue, step sequencer with pending-note-off tracking. Don't usually need to touch this.
- **`src/PluginEditor.{h,cpp}`** — hosts the WebView, serves bundled assets, wires JS callbacks to the processor.
- **`web/shell.js`** — owns the Three.js renderer/scene/camera, animation loop, key+scale system, experiment selector UI, and the MIDI/transport/scale APIs surfaced to experiments.
- **`web/<experiment>.js`** — one file per experiment (e.g. [graph.js](web/graph.js), [scribbler.js](web/scribbler.js)). Each registers itself with `Shell.register()` and implements `init / update / pause / resume / destroy`.
- **`web/test.js`** — dedicated prototyping scratchpad. New ideas start here; once they're keepers they get duplicated to a named file.
- **`web/three.min.js`, `web/matter.min.js`** — vendored Three.js (graphics) and Matter.js (2D physics, optional).

## Experiment contract

Every experiment receives a `context` from the shell with:

- `scene`, `camera`, `renderer` — Three.js handles
- `midi.sendNoteOn(note, velocity, channel)` / `sendNoteOff` / `sendNote(note, vel, ch, durationMs)`
- `scale.getNotesInRange(low, high)`, `getNoteForDegree`, `getScaleDegree`, `onChange(cb)`, `getKey()` — key/scale-aware MIDI helpers
- `getTransport()` — `{ tempo, beatPosition, timeSigNumerator, timeSigDenominator, isPlaying }`
- `getSize()` — current canvas dimensions

The shell drives `update(delta, transport)` every frame; experiments never call `requestAnimationFrame` or `renderer.render()` themselves.

See [.cursorrules](.cursorrules) for the full experiment contract and prototyping workflow.

## Build

Requires CMake ≥ 3.22 and a C++20 compiler. JUCE is fetched automatically.

```sh
cmake -B build
cmake --build build
```

The plugin is configured to copy the built VST3 to the system plugin directory after each build (`COPY_PLUGIN_AFTER_BUILD TRUE`). Adding a new `.js` file under `web/` is automatically picked up by `file(GLOB web/*.js)` — no CMake edits needed.

## Status

Scaffold / experimental. The C++ layer is intentionally minimal and stable; the web layer is where new sequencer ideas get tried out.
