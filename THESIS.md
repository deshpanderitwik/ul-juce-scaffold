# Beyond the piano roll

A living document. It collects the argument this project is making, built up one exploration at a time, and becomes the spine of a video. Explorations live in `experiments/` (interactive studies) and the plugin's `web/` experiments. Shots for the video live in `animations/` (frame-clocked pages that export to video).

## The question

How can people interact with music on a computer in ways that go beyond the piano roll?

## Current statement

*v0, 2026-10-16.* The piano roll is a brilliant editor for scores, and we've mistaken it for an instrument. Every assumption it makes about time, pitch, notes and the hand can be dropped, and each one we drop opens up a different way to play.

## What the piano roll assumes

1. **Time is a horizontal ruler you see all at once.** You edit a frozen picture of the music, not the music itself.
2. **Pitch is twelve rows, most of them wrong.** Every chromatic note is equally available; knowing the key is your job.
3. **The note is the smallest unit.** You place events one by one; you can't describe a behaviour.
4. **Editing and playing are separate modes.** Stop, draw, play, listen, repeat.
5. **The mouse is a pen.** Interaction means drawing rectangles precisely.

## Counter-proposals so far

Status: **seen** means watched or played and confirmed; **inferred** means guessed from names and descriptions, not yet checked.

| Assumption | Counter-proposal | Where | Status |
|---|---|---|---|
| 2 | The space contains only in-key notes. Wrong notes aren't possible, so harmony belongs to the surface. | every `web/` experiment (`ctx.scale`) | seen (code) |
| 3 | A melody is a path through a network of scale degrees; the connections have physical give. | `web/graph.js`, `sketches/` | inferred |
| 3 | Set up a process instead of placing events: a walker, runners on paths. | `web/random-walker.js`, `web/exploration-1.js` | inferred |
| 3 | Notes as tendencies: per-note probability and delay mean the loop is never quite the same twice. | the step sequencer | seen (code) |
| 5 | Gesture as performance: swipe through notes, pull a pulse to change its rate, lift a slice of the scale. | `web/scribbler.js`, `web/scratch.js`, `web/scale-flick.js` | inferred |
| 4 | The interface is a lens on a loop that is always running; you reshape it while it plays. | the plugin's design | seen (code) |
| 1 | Rebuild the timeline from nothing: line, one point, the one, subdivision, bars, lengths, voices, relations. | `experiments/001`–`018` | inferred |

## Emerging principles

Candidates, to be confirmed or killed by the explorations:

- Narrow the space, free the gesture.
- Describe behaviour, not events.
- The interface is a lens, not a document.

## Open questions

- Is the video a manifesto (here's the answer) or a lab notebook (here's the search)?
- Who is it for: musicians, creative coders, or a general art audience?
- Which assumption is the most interesting to break, and which experiment breaks it most clearly?

## Log

Newest first. One entry per exploration or shot: what we tried, which assumption it questioned, what we learned, and any animation it produced.

### 2026-10-16: exploring time, shot one: the origin of time

- Starting the exploration of time (assumption 1) from before the ruler exists: a point, then a line, then musical division.
- Visual language fixed for the shots: monochrome on black, with one accent, the Listening Room orange `#ff6e35` (`animations/theme.js`). The orange marks the origin, "the one".
- `animations/002-origin-of-time`: the orange point appears and swells once; a line grows out of it to the right (the pair stays centred, so the point ends up at the start); then the line is divided coarse to fine (bar ends, beats, eighths, sixteenths), each level shorter and fainter, arriving left to right. Before any marker appears, the point shrinks away: the origin is gone by the time time is divided. 14.2 s.
- Thought to carry forward: the piano roll starts at the last frame of this shot, a ruler already divided. Everything before that frame is a choice the piano roll has already made for you.

### 2026-10-16: the thesis, and somewhere to make shots

- Settled on the question: going beyond the piano roll.
- Wrote down the five assumptions and matched the existing work against them (mostly inferred, see the table).
- Set up `animations/`, a frame-clock runtime for video shots. `001-blank` is its starting template.

## Shots

Animations made for the video, and the part of the argument each one serves.

| Animation | Serves | Notes |
|---|---|---|
| `animations/001-blank` | — | Template; proves the clock. |
| `animations/002-origin-of-time` | Assumption 1: time as a ruler | Point → line → bar, beats, eighths, sixteenths. Opening shot of the time section. |
