// The bar the time shots are built on, shared so that each shot starts on
// exactly the frame the one before it ends on.
//
// 002-origin-of-time ends on the divided line: LEVELS, coarse to fine.
// 003-cells opens it into a strip of sixteen cells: drawCells(g, W, H, u),
// where u = 0 is the divided line and u = 1 the cells. Shots after that
// draw the cells with u = 1 and use cell(i) to place things in them.
//
// Sizes are px at 1920 x 1080.
(() => {
'use strict';

const LENGTH = 1200;          // one bar
const STEPS = 16;             // sixteenths
const CELL = LENGTH / STEPS;  // 75: the cells are square
const LINE_ALPHA = 0.55;

// The divisions the line ends 002 with: bar ends, beats, eighths, sixteenths.
const LEVELS = [
  { half: 46, alpha: 0.9,  marks: [0, 1] },
  { half: 31, alpha: 0.7,  marks: [1, 2, 3].map((i) => i / 4) },
  { half: 20, alpha: 0.48, marks: [1, 3, 5, 7].map((i) => i / 8) },
  { half: 12, alpha: 0.3,  marks: [1, 3, 5, 7, 9, 11, 13, 15].map((i) => i / 16) },
];

// The cells keep a quieter version of the hierarchy, so they still read as
// four beats of four: a wall's brightness by its level.
const WALL_ALPHA = [0.8, 0.6, 0.36, 0.36];
const EDGE_ALPHA = 0.5;

// Which level the boundary at sixteenth i (0..16) belongs to.
const levelOf = (i) => (i % 16 === 0 ? 0 : i % 4 === 0 ? 1 : i % 2 === 0 ? 2 : 3);

const x0 = (W) => (W - LENGTH) / 2;
const cy = (H) => H / 2;

// Two coincident edges at this alpha composite to the single line's 0.55,
// so the line can split in two without a jump in brightness.
const HALF_LINE = 1 - Math.sqrt(1 - LINE_ALPHA);

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// The divided line (u = 0) opening into cells (u = 1). The line splits into
// a top and a bottom edge that move apart, and every division stretches or
// shrinks to span exactly between them. u may overshoot 1.
function drawCells(g, W, H, u = 1) {
  const left = x0(W), mid = cy(H), open = CELL / 2 * u;
  g.save();
  g.lineCap = 'round';
  g.lineWidth = Theme.stroke;

  // Still closed, it is 002's single line, drawn exactly as 002 draws it.
  g.strokeStyle = u > 0 ? Theme.ink(lerp(HALF_LINE, EDGE_ALPHA, smooth(u / 0.25))) : Theme.ink(LINE_ALPHA);
  for (const y of u > 0 ? [mid - open, mid + open] : [mid]) {
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(left + LENGTH, y);
    g.stroke();
  }

  // The walls head for where the edges actually are, not for their resting
  // place, so a u past 1 (a spring's overshoot) stretches whole cells
  // instead of leaving the walls short of the edges.
  const w = Math.min(1, Math.max(0, u));
  for (let i = 0; i <= STEPS; i++) {
    const k = levelOf(i);
    const half = lerp(LEVELS[k].half, open, w);
    const x = left + i * CELL;
    g.strokeStyle = Theme.ink(lerp(LEVELS[k].alpha, WALL_ALPHA[k], w));
    g.beginPath();
    g.moveTo(x, mid - half);
    g.lineTo(x, mid + half);
    g.stroke();
  }
  g.restore();
}

// The centre of cell i (0..15).
const cell = (i, W, H) => ({ x: x0(W) + (i + 0.5) * CELL, y: cy(H) });

// The rhythm 004 fills in and later shots play: 3 + 3 + 2 + 3 + 3 + 2.
const RHYTHM = [0, 3, 6, 8, 11, 14];
const FILL_INSET = 11;        // px between a fill and its cell's walls

// A note: an orange rounded rectangle centred on (x, y). pale (0..1)
// mixes it toward white, for arrivals and hits.
function drawNote(g, x, y, w, h, pale = 0) {
  g.fillStyle = Theme.rgba(Theme.ACCENT.map((c) => Math.round(c + (255 - c) * pale)));
  g.beginPath();
  g.roundRect(x - w / 2, y - h / 2, w, h, 3);
  g.fill();
}

// A filled cell: an orange square at its resting size when scale is 1.
function drawFill(g, W, H, step, scale = 1, pale = 0) {
  const size = (CELL - 2 * FILL_INSET) * scale;
  const { x, y } = cell(step, W, H);
  drawNote(g, x, y, size, size, pale);
}

// The playhead: a white line a little taller than what it plays (span,
// the height of the cells by default, centred on mid), at x. grow (0..1)
// draws it out from the centre.
function drawPlayhead(g, W, H, x, alpha = 1, grow = 1, span = CELL, mid = cy(H)) {
  const half = (span / 2 + 10) * grow;
  g.save();
  g.lineCap = 'round';
  g.lineWidth = Theme.stroke;
  g.strokeStyle = Theme.ink(alpha);
  g.beginPath();
  g.moveTo(x, mid - half);
  g.lineTo(x, mid + half);
  g.stroke();
  g.restore();
}

// A faint wake behind the moving playhead, as long as its speed makes it,
// over the span from top down by height.
function drawWake(g, W, x, cellsPerSecond, top, height) {
  const wake = cellsPerSecond * 0.09 * CELL;
  if (wake <= 1) return;
  const from = Math.max(x0(W), x - wake);
  const grad = g.createLinearGradient(x - wake, 0, x, 0);
  grad.addColorStop(0, Theme.ink(0));
  grad.addColorStop(1, Theme.ink(0.12));
  g.fillStyle = grad;
  g.fillRect(from, top, x - from, height);
}

// The playhead's travel, one clock for every shot it plays through, so a
// cut between them is invisible. s is seconds since it started moving: it
// comes up to tempo from rest (its speed a smoothstep over UP seconds) and
// then holds it. Positions are in cells; a bar is STEPS of them.
const Play = (() => {
  const BPM = 100;
  const SPEED = BPM / 60 * 4;            // cells per second at tempo
  const UP = 2.5;
  const RAMP = SPEED * UP / 2;           // cells covered coming up to tempo
  const smooth = (x) => x * x * (3 - 2 * x);

  const travelled = (s) => {
    if (s <= 0) return 0;
    if (s < UP) { const x = s / UP; return SPEED * UP * (x ** 3 - x ** 4 / 2); }
    return RAMP + SPEED * (s - UP);
  };
  const speed = (s) => (s <= 0 ? 0 : s < UP ? SPEED * smooth(s / UP) : SPEED);

  // When the playhead reached position p: exact at tempo, a bisection on
  // the way up (travelled rises monotonically).
  const reachedAt = (p) => {
    if (p <= 0) return 0;
    if (p >= RAMP) return UP + (p - RAMP) / SPEED;
    let lo = 0, hi = UP;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (travelled(mid) < p) lo = mid; else hi = mid;
    }
    return hi;
  };

  // How on the note at cell `step`, `len` cells long, is (0..1): on for as
  // long as the playhead is inside it, the way a held key sounds, with a
  // 30 ms attack and a 120 ms release. Without sound, this is the note.
  const ATTACK = 0.03, RELEASE = 0.12;
  const gate = (step, len, s) => {
    if (s < 0) return 0;
    const p = travelled(s);
    const k = Math.floor((p - step) / STEPS);
    if (k < 0) return 0;
    const start = step + k * STEPS;
    if (p < start + len) return Math.min(1, (s - reachedAt(start)) / ATTACK);
    return Math.max(0, 1 - (s - reachedAt(start + len)) / RELEASE);
  };

  // How lit the point at cell position c of the note starting at `step` is
  // (0..1). The whole note lights as the playhead enters it; behind the
  // playhead, each point fades back to the note's colour over the DECAY
  // seconds after the line passed it, so the played part cools while the
  // rest is still sounding.
  const DECAY = 0.45;
  const lit = (step, c, s) => {
    if (s < 0) return 0;
    const p = travelled(s);
    const k = Math.floor((p - step) / STEPS);
    if (k < 0) return 0;
    const start = step + k * STEPS;
    const on = Math.min(1, (s - reachedAt(start)) / ATTACK);
    const at = start + (c - step);
    return at > p ? on : on * Math.exp(-(s - reachedAt(at)) / DECAY);
  };

  // 005 starts the playhead 0.9 s in and plays until it is back on the one
  // for the third time; 006 starts on the frame after, so the rows unfold
  // on a downbeat, and lasts two bars; 007 starts on the next downbeat.
  // START[shot] is when each shot's t = 0 falls on this clock
  // (s = t + START).
  const BAR = STEPS / SPEED;             // seconds
  const MOVE_AT = 0.9;
  const PLAYING_FOR = Math.round((MOVE_AT + reachedAt(3 * STEPS)) * 60) / 60;
  const ROWS_FOR = 2 * BAR;
  const START = { playing: -MOVE_AT, rows: PLAYING_FOR - MOVE_AT };
  START.melody = START.rows + ROWS_FOR;

  return { BPM, SPEED, BAR, MOVE_AT, PLAYING_FOR, ROWS_FOR, START, travelled, speed, reachedAt, gate, lit };
})();

// A note as the playhead plays it, at clock time s: `len` cells from cell
// `step`, centred vertically on y, h tall at rest. While it is on it swells
// a little, and its colour runs from the note's orange, where the playhead
// passed a while ago, to near white, where it is now or has yet to reach.
function drawPlayedNote(g, W, step, len, y, h, s) {
  const side = CELL - 2 * FILL_INSET;
  const on = Play.gate(step, len, s);
  const w = len * CELL - 2 * FILL_INSET + 0.12 * on * side;
  const hh = h * (1 + 0.12 * on);
  const left = x0(W) + step * CELL + FILL_INSET - 0.06 * on * side;
  const mix = (l) => Theme.rgba(Theme.ACCENT.map((c) => Math.round(c + (255 - c) * 0.6 * l)));

  const samples = Math.max(2, Math.ceil(len * 10));
  const levels = [];
  for (let i = 0; i <= samples; i++) {
    const c = Math.min(step + len, Math.max(step, (left + i / samples * w - x0(W)) / CELL));
    levels.push(Play.lit(step, c, s));
  }
  // Unlit, it is drawn exactly as drawNote draws it, so cuts from shots
  // with resting notes stay pixel-exact.
  if (Math.max(...levels) < 1e-4) {
    g.fillStyle = mix(0);
  } else {
    const grad = g.createLinearGradient(left, 0, left + w, 0);
    levels.forEach((l, i) => grad.addColorStop(i / samples, mix(l)));
    g.fillStyle = grad;
  }
  g.beginPath();
  g.roundRect(left, y - hh / 2, w, hh, 3);
  g.fill();
}

window.Bar = {
  LENGTH, STEPS, CELL, LINE_ALPHA, LEVELS, RHYTHM, WALL_ALPHA, EDGE_ALPHA, FILL_INSET,
  x0, cy, levelOf, drawCells, cell, drawNote, drawFill, drawPlayedNote, drawPlayhead, drawWake, Play,
};
})();
