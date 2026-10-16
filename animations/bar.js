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

window.Bar = { LENGTH, STEPS, CELL, LINE_ALPHA, LEVELS, x0, cy, levelOf, drawCells, cell };
})();
