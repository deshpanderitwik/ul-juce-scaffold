// The piano roll the time shots grow into, shared so that each shot starts
// on exactly the frame the one before it ends on. It is bar.js's strip of
// cells multiplied by pitch: the same sixteen columns, now thirteen rows,
// one per semitone from B up to B, with a keyboard on the left. The strip
// becomes the middle row, F, so it never has to move: the roll grows up and
// down out of it.
//
// Rows can be part open: a shot passes every row's current height, and
// layout() stacks them from a bottom edge (by default, where the open roll
// sits centred on the bar's centre line). With every row closed but the
// strip's (STRIP_ROW, at the cells' height and in the cells' place),
// drawGrid() draws exactly what Bar.drawCells(g, W, H, 1) draws.
//
// Needs theme.js and bar.js. Sizes are px at 1920 x 1080.
(() => {
'use strict';

const ROWS = 13;
const ROW = 40;              // an open row's height
const LOW = 11;              // row 0's pitch class: B
const STRIP_ROW = 6;         // the strip of cells becomes the middle row, F
const BLACK = new Set([1, 3, 6, 8, 10]);   // pitch classes, C = 0
const KEYS_W = 100;          // the keyboard's width
const KEYS_GAP = 8;          // between the keyboard and the grid
const LINE_ALPHA = 0.18;     // the lines between rows
const SHADE = 0.045;         // white-key rows are lifted this much off black

const isBlack = (row) => BLACK.has((LOW + row) % 12);
const OPEN = Array(ROWS).fill(ROW);

// The bottom edge of the open roll, centred on the bar's centre line.
const centredBottom = (H) => Bar.cy(H) + ROWS * ROW / 2;

// Where each row is, from their current heights, stacked bottom (row 0) to
// top from the bottom edge `base`.
function layout(heights, H, base = centredBottom(H)) {
  const total = heights.reduce((a, b) => a + b, 0);
  const top = [], bottom = [], mid = [];
  let y = base;
  for (let i = 0; i < ROWS; i++) {
    bottom[i] = y;
    y -= heights[i];
    top[i] = y;
    mid[i] = (top[i] + bottom[i]) / 2;
  }
  return { heights, total, top, bottom, mid, gridTop: y, gridBottom: base };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The grid: white-key shading (shade 0..1), the lines between rows, the
// outer edges and the sixteen columns' walls. A closed row's lines sit on
// the edge and are left out; as it opens, the line it leaves behind fades
// from an edge's brightness to a row line's.
function drawGrid(g, W, H, L, shade = 1) {
  const left = Bar.x0(W), right = left + Bar.LENGTH;
  g.save();
  g.lineCap = 'round';

  if (shade > 0) {
    g.fillStyle = Theme.ink(SHADE * shade);
    for (let i = 0; i < ROWS; i++) {
      if (!isBlack(i) && L.heights[i] > 0) g.fillRect(left, L.top[i], Bar.LENGTH, L.heights[i]);
    }
  }

  g.lineWidth = 2;
  for (let i = 0; i < ROWS - 1; i++) {
    const m = Math.min(L.heights[i], L.heights[i + 1]);
    if (m < 0.5) continue;
    g.strokeStyle = Theme.ink(Bar.EDGE_ALPHA + (LINE_ALPHA - Bar.EDGE_ALPHA) * smooth(0, ROW, m));
    g.beginPath();
    g.moveTo(left, L.top[i]);
    g.lineTo(right, L.top[i]);
    g.stroke();
  }

  g.lineWidth = Theme.stroke;
  g.strokeStyle = Theme.ink(Bar.EDGE_ALPHA);
  for (const y of [L.gridTop, L.gridBottom]) {
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(right, y);
    g.stroke();
  }

  for (let i = 0; i <= Bar.STEPS; i++) {
    const x = left + i * Bar.CELL;
    g.strokeStyle = Theme.ink(Bar.WALL_ALPHA[Bar.levelOf(i)]);
    g.beginPath();
    g.moveTo(x, L.gridTop);
    g.lineTo(x, L.gridBottom);
    g.stroke();
  }
  g.restore();
}

// The keyboard, one key per row, against the grid's left edge. progress(i)
// (0..1) is how far key i has slid out from the grid. The black keys sit
// on the far side, as on a keyboard turned so its low end is at the bottom.
function drawKeys(g, W, H, L, progress) {
  const right = Bar.x0(W) - KEYS_GAP;
  g.save();
  for (let i = 0; i < ROWS; i++) {
    const p = progress(i);
    if (p <= 0 || L.heights[i] < 2) continue;
    const w = KEYS_W * p;
    const y = L.top[i] + 1, h = L.heights[i] - 2;
    const a = Math.min(1, p * 1.5);
    g.fillStyle = Theme.ink(0.8 * a);
    if (!isBlack(i)) {
      g.fillRect(right - w, y, w, h);
      continue;
    }
    const front = w * 0.38;
    g.fillRect(right - front, y, front, h);
    g.strokeStyle = Theme.ink(0.4 * a);
    g.lineWidth = 1.5;
    g.strokeRect(right - w + 0.75, y + 0.75, w - front - 1.5, h - 1.5);
  }
  g.restore();
}

// The melody 007 makes of the six Fs: F, A flat, B flat, G, E flat, C, in
// F minor, climbing above F and then falling below it, three notes held
// longer. len is in cells.
const MELODY = [
  { step: 0,  row: 6,  len: 1 },   // F
  { step: 3,  row: 9,  len: 3 },   // A flat
  { step: 6,  row: 11, len: 1 },   // B flat
  { step: 8,  row: 8,  len: 3 },   // G
  { step: 11, row: 4,  len: 1 },   // E flat
  { step: 14, row: 1,  len: 2 },   // C
];

// A note's height in an open row: the cells' fill, squashed as the row is.
const NOTE_H = (Bar.CELL - 2 * Bar.FILL_INSET) * ROW / Bar.CELL;

window.Roll = {
  ROWS, ROW, STRIP_ROW, KEYS_W, KEYS_GAP, OPEN, MELODY, NOTE_H,
  isBlack, centredBottom, layout, drawGrid, drawKeys,
};
})();
