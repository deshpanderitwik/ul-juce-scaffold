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

## Next: how a digital composition forms

Intention set 2026-10-16, after 007. Continue the time reel from the playing melody:

1. **Encapsulate.** The melody collapses into a clip: the piano roll folds down into a compact block that still shows its notes in miniature, and the clip is placed on a timeline.
2. **The other parts, the same way.** A drum pattern, some chords and a bassline are each written, encapsulated into a clip and placed on the timeline, following the same steps as the melody (quicker each time, since the viewer now knows the process).
3. **Arrange.** The clips are laid out on a DAW-style timeline: tracks as lanes, clips repeated and arranged into a song form.

The arc: point → line → cells → notes → piano roll → clip → track → arrangement. It shows how a digital composition is built up, one container inside another, which the rest of the video can then question.

Open before building:
- Telling four parts apart with one accent colour: shape (drums as hits, chords as stacks, bass as long low notes), position (lanes), or tints of the orange?
- Does each part get its own written-out sequence (cells for drums, roll for the rest), or does only the melody get the full treatment and the others arrive faster?
- Does the playhead keep running through all of it, as it has since 005?

## Log

Newest first. One entry per exploration or shot: what we tried, which assumption it questioned, what we learned, and any animation it produced.

### 2026-10-16: exploring time, shot six: the notes become a melody

- `animations/007-melody`: still playing, the six notes, all on C, become a melody one pass at a time, each change landing just behind the playhead, the way you'd edit a running loop. Bar 1: each note slides up or down from F to its pitch (F, A flat, B flat, G, E flat, C: F minor, climbing above F and falling below it). Bar 2: three of them stretch into longer notes. Bar 3: the melody plays; each note, long or short, stays lit for as long as the playhead is inside it, so length is visible as duration. 7.2 s.
- The structure springs into being, but notes glide to their places: placing a note should look deliberate, not bouncy.
- What the piano roll adds to the strip, in order: a vertical axis (pitch), then a second horizontal quantity (length). The strip had only *when*.

### 2026-10-16: exploring time, shot five: the structure of a piano roll

- Structure first, then the notes, one beat each. Pitch-first (notes floating to heights, rows forming to catch them) was the alternative; it says why the rows exist, but structure-first is clearer to read.
- `animations/006-rows`: on a downbeat, with the music still playing, thirteen rows (B up to B) grow out of the strip, up and down at once. The strip never moves: it becomes the middle row, F, so every note entered on the grid turns out to be an F, still lighting up as the playhead passes through them. The rows start as tall as the cells and narrow toward piano-roll rows as more open, so the roll only ever grows; the columns and the playhead stretch to the full height. Then the keyboard slides out on the left and the white-key rows lift faintly off the black. Two bars, 4.8 s.
- The strip was always one pitch; the roll just reveals which one. Putting it in the middle means the melody can go both up and down from where the rhythm was written.
- The playhead never stops: 005 and 006 share one clock (`Bar.Play`), and the cut between them falls on a downbeat. The structure changes under music that is already running, which is the opposite of how a piano roll is used (stop, edit, play).
- All twelve rows exist before any note needs them. The notes sitting in one row of twelve is the first look at assumption 2: every chromatic pitch is equally available, whether or not the music wants it.
- The videos had been encoded with the SD colour matrix, so the orange played back as `#ff6838`. Encoding is now BT.709 and tagged; frames were always right.

### 2026-10-16: exploring time, shot four: time starts moving

- `animations/005-playing`: a white playhead draws itself at the left edge of the filled cells, comes up to tempo from rest like a turntable (100 bpm), and plays the bar until it comes round to the one for the third time, where 006 takes over without a break. Each orange cell is lit, toward white and a little larger, for as long as the line is inside it, and goes dark as the line leaves. Empty cells don't react. 9.35 s.
- The playhead is white because it belongs to the structure; orange stays music. The line is continuous, not a step highlight, so it can grow into a piano roll's playhead in the next beat. Discrete grid, continuous time.
- A note is a sustained "on" state, not a strike: it lights as the playhead enters and stays on while the playhead is inside it, the way a held key sounds; the part already played cools slowly back to orange behind the line. Without sound, being lit is the note sounding, and the cooling shows how much of it has been heard.

### 2026-10-16: exploring time, shots two and three: cells, and filling them

- The plan for the time section, one beat per animation, joined into a reel (`animations/reels.json`, `python3 animations/reel.py time`): point → line → cells → filled cells → movement across them → the cells become a piano roll → the hand that edits it. Soundless for now.
- Both openings are springs, but not the same one: the line leaves the point gently (from rest, about 7% overshoot), and the cells fly open (flung, about 25% overshoot, `util.spring`). The energy rises as the structure gets more musical.
- `animations/003-cells`: the divided line springs open into sixteen square cells. The line splits into a top and a bottom edge that fly apart, overshoot and settle, and every division stretches to span between them. The walls keep a quieter version of the old hierarchy, so it still reads as four beats of four. 2.6 s.
- `animations/004-filling`: some cells fill with orange, one at a time, in a 3 + 3 + 2 + 3 + 3 + 2 rhythm. The grid is every place something could happen; the filled cells are the places it does. 4 s.
- The orange now has a meaning across shots: it is where music is. First the origin, then the notes. The structure (line, divisions, cells) stays white.
- A strip of cells is already a step sequencer: one row of time with on/off in each step. The piano roll will be this strip multiplied by pitch.

### 2026-10-16: exploring time, shot one: the origin of time

- Starting the exploration of time (assumption 1) from before the ruler exists: a point, then a line, then musical division.
- Visual language fixed for the shots: monochrome on black, with one accent, the Listening Room orange, now `#ff5a3c` (`animations/theme.js`). It started as `#ff6e35` and moved a step redder (hue 17° to 9°) across every touchpoint, to keep it clear of saffron and its political reading. The orange marks the origin, "the one".
- `animations/002-origin-of-time`: the orange point appears and swells once; a line springs gently out of it to the right, overshooting a little and settling (the pair stays centred, so the point drifts to the start); then the line is divided coarse to fine (bar ends, beats, eighths, sixteenths), each level shorter and fainter, arriving left to right. Before any marker appears, the point shrinks away: the origin is gone by the time time is divided. 13.2 s.
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
| `animations/003-cells` | Assumption 1 | The divided line opens into sixteen cells. |
| `animations/004-filling` | Assumptions 1 and 3 | Cells fill in a rhythm: grid versus music. |
| `animations/005-playing` | Assumptions 1 and 4 | A playhead plays the cells; the music answers. |
| `animations/006-rows` | Assumption 2 | The strip grows into twelve rows and a keyboard: the piano roll's structure. |
| `animations/007-melody` | Assumptions 2 and 3 | The notes move to pitches and lengthen, edited behind the playhead. |
