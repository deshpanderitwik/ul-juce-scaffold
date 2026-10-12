// ==========================================================================
// Exploration 1 — runners and paths on the pitch field
//
// Height is pitch. The notes of the current scale across the 88 keys of a
// piano are stacked up the field, lowest at the bottom, each owning a
// horizontal band. The window shows fifteen of them at a time; scroll to move
// up and down the range. A ruler down the left edge names every note at the
// height it sits.
//
// Across is chance. A note in the middle of the field always plays; the
// further out to either side it sits, the more often it stays silent, decided
// afresh every time it comes round. Things towards the edges are drawn
// fainter, and a runner only flashes on the hits that actually sounded.
//
// Click the field and a ring of subdivisions blooms around the spot; click
// one and a runner lands there, pulsing its note at that rate. Drag a runner
// anywhere (holding it at the top or bottom of the window scrolls the field
// under it); click it to change its rate, give it a path, or remove it.
//
// A path is a string of waypoints. Its runner travels from one to the next,
// one waypoint per pulse, playing each waypoint's note as it arrives, and
// returns to the first after the last. Lay one by choosing the pencil on a
// runner's ring (or double-clicking the runner) and clicking the field for
// each waypoint; drag a waypoint to reshape the path afterwards.
//
// Clear, at the top right, removes every runner and path. It asks once
// before it does, because there is no way back.
//
// Everything is handed to the sequencer as one pattern, so the runners stay
// locked to each other and to the transport, and the ones on screen are drawn
// from the transport position.
// ==========================================================================

const Exploration1Experiment = {
  id: 'exploration-1',
  name: 'Exploration 1',
  description: 'Runners and paths on the pitch field',

  // The field covers a fixed range, so the octave picker has nothing to move.
  showOctave: false,

  // The pattern is built on sixteenth-note steps whatever the runners' rates:
  // fine enough that no runner hits twice inside one step, which is what lets
  // a step's report of what sounded be matched to the runner that made it.
  subdivisions: ['1/16'],
  showSubdivision: false,

  _ctx: null,
  _unsubscribeScale: null,

  // ---- the field ----
  _lowNote:  21,          // the lowest key of a piano
  _highNote: 108,         // the highest
  _visibleRows: 15,       // notes on screen at once
  _homeNote: 48,          // the note at the bottom of the window before anything is saved (C2)
  _rulerWidth:  64,       // left strip the ruler occupies; nothing is placed there
  _topInset:    84,       // from the top of the window to the top row (clears the top bar)
  _bottomInset: 44,       // from the bottom of the window to the bottom row
  _ladder: [],            // the scale's notes inside the range, low to high
  _rows: [],              // per note: { tick, label, line } (line = the boundary above it, if any)
  _rowHeight: 0,
  _scroll: 0,             // which note sits on the bottom row, as a position in the ladder (can be fractional)
  _fieldBottom: 0,        // y of the bottom row
  _fieldTop: 0,           // y of the top row
  _fieldGroup: null,

  // ---- runners ----
  // Pulse rates on offer. `d` is the denominator of a whole note, so triplets
  // sit between the straight values (1/8T = 12 is three to a quarter).
  _subdivisions: [
    { label: '1',    d: 1 },
    { label: '1/2',  d: 2 },
    { label: '1/4',  d: 4 },
    { label: '1/4T', d: 6 },
    { label: '1/8',  d: 8 },
    { label: '1/8T', d: 12 },
    { label: '1/16', d: 16 },
  ],
  _gateMs: 110,           // how long each pulse holds its note
  _chanceFloor: 0.05,     // chance at the far left and far right
  _chanceSure: 0.08,      // this close to the middle (as a share of the way out), a note always plays
  _maxRunners: 12,
  _runnerRadius: 14,
  _runnerHit: 22,         // how close a click has to be to count as on a runner

  // A runner without a path sits at (x, midi). With one, it travels through
  // path[0], path[1], ... and (x, midi) mirrors path[0].
  _runners: [],           // { id, x, midi, d, path, view, lastPulse, pop, px, py, shown, drawn, atHome }
  _nextId: 1,
  _runnerGroup: null,

  // ---- paths ----
  _maxWaypoints: 32,
  _handleRadius: 6,
  _handleHit: 14,         // how close a press has to be to grab a waypoint
  _pathGroup: null,
  _pathViews: [],         // per runner with a path: { runner, line, handles }
  _laying: null,          // { runner, points, pointer }: the path being laid
  _layGroup: null,        // the line and dots, redrawn as the path grows
  _layButtonGroup: null,
  _layButtons: [],        // { kind, x, y }
  _layButtonRadius: 15,

  // Time is counted in ticks of a 48th of a bar, the coarsest grid every rate
  // on offer lands on. The pattern is as long as it takes every runner's
  // cycle to come round together.
  _ticksPerBeat: 12,
  _ticksPerBar: 48,
  _patternTicks: 48,
  _stepTicks: 3,
  _numSteps: 16,
  _maxSteps: 256,         // the longest pattern the sequencer takes
  _maxNotesPerStep: 48,

  // What the sequencer reported for the steps just played: pattern step ->
  // { notes, at }. A runner's hit is checked against it to see if it sounded.
  _heard: null,
  _now: 0,                // seconds since init, for ageing those reports
  _wasPlaying: false,
  _live: 0,

  // ---- ripples: a hairline ring shed from a runner on every pulse ----
  _rippleGroup: null,
  _ripples: [],           // { mesh, age } with age < 0 meaning free
  _rippleCount: 24,
  _rippleLife: 0.5,       // seconds
  _rippleSpeed: 110,      // px per second
  _rippleAlpha: 0.28,

  // ---- the radial ----
  _radialRadius: 92,
  _chipWidth: 60,
  _chipHeight: 44,
  _chipHit: 34,           // how close a click has to be to a chip's centre
  _staggerIn: 0.034,      // seconds between successive chips springing out
  _staggerOut: 0.024,     // seconds between chips receding
  _radial: null,          // { x, y, target, chips, ghost, hover, closing, age, g }
  _radialGroup: null,

  // ---- the clear button ----
  _clearGroup: null,
  _clear: null,           // { x, y, border, fill, label, confirm, hover, armedUntil }
  _clearWidth: 56,
  _clearHeight: 26,
  _clearConfirmSeconds: 2.5,   // how long it waits for the second click

  // { x, y, runner, handle, dragging, at }: where the pointer went down, on
  // what, and where it is now.
  _press: null,
  _edgeScrollSpeed: { min: 2, max: 14, perRow: 6 },   // rows per second while a drag is held at an edge

  // ====================================================================
  // The field
  // ====================================================================

  // y of the i-th note of the ladder (0 = lowest) at the current scroll. It
  // may be off either end of the window.
  _yForIndex(i) {
    return this._fieldBottom + (i - this._scroll) * this._rowHeight;
  },

  // Index in the ladder of the note whose band contains y.
  _indexAtY(y) {
    const i = Math.round((y - this._fieldBottom) / this._rowHeight + this._scroll);
    return Math.max(0, Math.min(this._ladder.length - 1, i));
  },

  // How much of something at height y shows: 1 inside the window, fading to
  // nothing over the half row beyond its top and bottom rows, so notes slide
  // in and out at the edges instead of spilling over the top bar.
  _edgeFade(y) {
    const half = this._rowHeight / 2;
    const inside = Math.min(y - (this._fieldBottom - half), (this._fieldTop + half) - y);
    return Math.max(0, Math.min(1, inside / half));
  },

  _maxScroll() {
    return Math.max(0, this._ladder.length - this._visibleRows);
  },

  // Index in the ladder of the scale note closest to a MIDI note. Runners and
  // waypoints keep the note they were planted on and play the nearest one the
  // current scale has, so changing key and coming back returns them to where
  // they were.
  _indexForMidi(midi) {
    let best = 0;
    for (let i = 1; i < this._ladder.length; i++) {
      if (Math.abs(this._ladder[i] - midi) < Math.abs(this._ladder[best] - midi)) best = i;
    }
    return best;
  },

  _noteFor(midi) {
    return this._ladder[this._indexForMidi(midi)];
  },

  _yForMidi(midi) {
    return this._yForIndex(this._indexForMidi(midi));
  },

  // The chance that something at x plays: certain in the middle of the
  // field, falling away evenly towards both sides.
  _chanceAt(x) {
    const left  = this._rulerWidth + this._runnerRadius;
    const right = this._ctx.getSize().width - this._runnerRadius;
    const out = Math.min(1, Math.abs(x - (left + right) / 2) / ((right - left) / 2));
    if (out <= this._chanceSure) return 1;
    return 1 - (1 - this._chanceFloor) * (out - this._chanceSure) / (1 - this._chanceSure);
  },

  // The x at which a note always plays: the middle of the field.
  _sureX() {
    return (this._rulerWidth + this._runnerRadius + this._ctx.getSize().width - this._runnerRadius) / 2;
  },

  _inField(p) {
    const half = this._rowHeight / 2;
    return p.x >= this._rulerWidth
        && p.y >= this._fieldBottom - half && p.y <= this._fieldTop + half;
  },

  // A spot on the field for something to be planted at: clear of the ruler,
  // on the line of the note whose band the pointer is in.
  _spotAt(p) {
    const size = this._ctx.getSize();
    const y = Math.max(this._fieldBottom, Math.min(this._fieldTop, p.y));
    return {
      x: Math.max(this._rulerWidth + this._runnerRadius, Math.min(size.width - this._runnerRadius, p.x)),
      midi: this._ladder[this._indexAtY(y)],
    };
  },

  // ====================================================================
  // Scene
  // ====================================================================

  init(ctx) {
    this._ctx = ctx;

    this._fieldGroup  = new THREE.Group();
    this._pathGroup   = new THREE.Group();
    this._rippleGroup = new THREE.Group();
    this._runnerGroup = new THREE.Group();
    this._layGroup    = new THREE.Group();
    this._layButtonGroup = new THREE.Group();
    this._clearGroup  = new THREE.Group();
    this._radialGroup = new THREE.Group();
    this._pathGroup.position.z   = 0.2;
    this._rippleGroup.position.z = 0.3;
    this._runnerGroup.position.z = 0.5;
    this._layGroup.position.z    = 1;
    this._layButtonGroup.position.z = 1.5;
    this._clearGroup.position.z  = 1.5;
    this._radialGroup.position.z = 2;
    ctx.scene.add(this._fieldGroup, this._pathGroup, this._rippleGroup, this._runnerGroup,
                  this._layGroup, this._layButtonGroup, this._clearGroup, this._radialGroup);

    this._heard = new Map();
    this._buildRipples();
    this._buildClearButton();
    this._unsubscribeScale = ctx.scale.onChange(() => this._rebuild());

    ctx.store.load((saved) => {
      this._runners = this._validRunners(saved);
      this._rebuild(saved && Number.isInteger(saved.bottom) ? saved.bottom : this._homeNote);
    });
  },

  _validRunners(saved) {
    const list = saved && Array.isArray(saved.runners) ? saved.runners : [];
    const rates = this._subdivisions.map(s => s.d);
    const isPoint = q => q && Number.isFinite(q.x) && Number.isInteger(q.midi);

    return list
      .filter(r => isPoint(r) && rates.includes(r.d))
      .slice(0, this._maxRunners)
      .map(r => {
        const path = Array.isArray(r.path) && r.path.length >= 2 && r.path.every(isPoint)
          ? r.path.slice(0, this._maxWaypoints).map(q => ({ x: q.x, midi: q.midi }))
          : null;
        return this._makeRunner(path ? path[0].x : r.x, path ? path[0].midi : r.midi, r.d, path);
      });
  },

  _makeRunner(x, midi, d, path) {
    return { id: this._nextId++, x, midi, d, path: path || null,
             view: null, lastPulse: null, pop: 0, px: x, py: 0, shown: false,
             drawn: false, atHome: false };
  },

  // The note on the bottom row is saved alongside the runners, so the window
  // reopens on the part of the range that was last being worked on.
  _save() {
    this._ctx.store.save({
      runners: this._runners.map(r => {
        const out = { x: r.x, midi: r.midi, d: r.d };
        if (r.path) out.path = r.path.map(q => ({ x: q.x, midi: q.midi }));
        return out;
      }),
      bottom: this._ladder[Math.round(this._scroll)],
    });
  },

  // The field and everything that sits on it, from the current scale, with
  // `bottomNote` (or the scale note nearest it) on the bottom row. Without
  // one, the window stays where it is.
  _rebuild(bottomNote) {
    if (bottomNote === undefined && this._ladder.length) {
      bottomNote = this._ladder[Math.round(this._scroll)];
    }

    const size = this._ctx.getSize();
    this._ladder      = this._ctx.scale.getNotesInRange(this._lowNote, this._highNote);
    this._fieldBottom = this._bottomInset;
    this._fieldTop    = size.height - this._topInset;
    this._rowHeight   = (this._fieldTop - this._fieldBottom) / (this._visibleRows - 1);
    this._scroll      = Math.min(this._maxScroll(), this._indexForMidi(bottomNote ?? this._homeNote));

    this._ctx.util.disposeGroup(this._fieldGroup);
    this._buildRows(size);
    this._layoutRows();

    this._closeRadial(true);
    this._buildRunnerViews();
    this._buildPathViews();
    this._drawLaying();
    this._sendPattern();
  },

  _line(group, points, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const line = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacity ?? 1 }));
    group.add(line);
    return line;
  },

  // The ruler's spine, and for every note of the ladder a tick and its name
  // on the ruler plus a faint line on the boundary with the note above, so
  // each note reads as a band. They are drawn at the origin and put in place
  // by _layoutRows, which is all a scroll has to redo.
  _buildRows(size) {
    const spineX = 50.5, tickLength = 8;

    this._line(this._fieldGroup, [spineX, this._fieldBottom, 0, spineX, this._fieldTop, 0], 0x323232);

    // What across means, under the middle and the two ends of the field.
    const hint = { width: 60, height: 14, font: '500 10px', alpha: 0.28 };
    const always = this._makeText('always', { ...hint, align: 'center' });
    always.position.set(Math.round(this._sureX()), 12, 0);
    this._fieldGroup.add(always);

    for (const x of [this._rulerWidth + 30, size.width - 34]) {
      const rarely = this._makeText('rarely', { ...hint, align: 'center' });
      rarely.position.set(x, 12, 0);
      this._fieldGroup.add(rarely);
    }

    this._rows = this._ladder.map((midi, i) => {
      const tick = this._line(this._fieldGroup, [spineX - tickLength, 0, 0, spineX, 0, 0], 0x585858);

      const label = this._makeText(this._ctx.scale.getNoteName(midi),
        { width: 32, height: 16, font: '600 11px', align: 'right', alpha: 0.5 });
      // The label's right edge sits a little left of its tick.
      label.position.x = spineX - tickLength - 6 - label.scale.x / 2;
      label.position.z = 0.1;
      this._fieldGroup.add(label);

      const line = i + 1 < this._ladder.length
        ? this._line(this._fieldGroup, [this._rulerWidth, 0, 0, size.width, 0, 0], 0x242424)
        : null;

      return { tick, label, line };
    });
  },

  _layoutRows() {
    const half = this._rowHeight / 2;

    this._rows.forEach((row, i) => {
      const y = this._yForIndex(i);
      const fade = this._edgeFade(y);

      row.tick.visible = row.label.visible = fade > 0;
      row.tick.position.y = Math.round(y) + 0.5;
      row.tick.material.opacity = fade;
      row.label.position.y = Math.round(y);
      row.label.material.opacity = fade;

      if (row.line) {
        // The boundary is half a row up, and only shows between two rows
        // that are both in the window.
        const edge = Math.min(fade, this._edgeFade(y + this._rowHeight));
        row.line.visible = edge > 0;
        row.line.position.y = Math.round(y + half) + 0.5;
        row.line.material.opacity = edge;
      }
    });
  },

  // Move the window along the ladder and redraw what depends on it.
  _scrollTo(scroll) {
    scroll = Math.max(0, Math.min(this._maxScroll(), scroll));
    if (scroll === this._scroll) return false;

    this._scroll = scroll;
    this._layoutRows();
    this._layoutPaths();
    this._drawLaying();
    return true;
  },

  // Scrolling moves the window towards the low notes when the page would
  // scroll down, as if the field were a tall document.
  onWheel(p, e) {
    if (this._scrollTo(this._scroll - e.deltaY / this._rowHeight)) this._closeRadial(true);
  },

  // Text on a small canvas, drawn at the screen's pixel density so it stays
  // sharp. It is drawn white and coloured through the sprite's material.
  _makeText(text, { width, height, font, align, alpha }) {
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width  = width * ratio;
    canvas.height = height * ratio;

    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    g.font = font + ' -apple-system, BlinkMacSystemFont, sans-serif';
    g.fillStyle = 'rgba(255, 255, 255, ' + (alpha ?? 1) + ')';

    if (align === 'center') {
      // Centred by the ink itself, measured, in both directions. Centring on
      // the font's own middle line leaves a word like "Clear" sitting low,
      // because that line allows for descenders the word does not have.
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      const m = g.measureText(text);
      const inkWidth  = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      g.fillText(text, (width - inkWidth) / 2 + m.actualBoundingBoxLeft,
                       (height - inkHeight) / 2 + m.actualBoundingBoxAscent);
    } else {
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.fillText(text, align === 'right' ? width : width / 2, height / 2 + 0.5);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.scale.set(width, height, 1);
    return sprite;
  },

  // A cross or a tick drawn as strokes inside the same box, so the two are
  // the same size and sit exactly on their button's centre, which the font's
  // own cross and tick glyphs do not. Drawn white, coloured through the
  // sprite's material like text.
  _makeIcon(kind) {
    const size = 24, reach = 4.6;
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size * ratio;

    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    g.translate(size / 2, size / 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.lineCap = g.lineJoin = 'round';

    g.beginPath();
    if (kind === 'cross') {
      g.moveTo(-reach, -reach); g.lineTo(reach, reach);
      g.moveTo(reach, -reach);  g.lineTo(-reach, reach);
    } else {
      // A tick as wide as the cross and centred on the same point.
      g.moveTo(-reach, 0.4);
      g.lineTo(-reach * 0.35, reach * 0.78);
      g.lineTo(reach, -reach * 0.78);
    }
    g.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.scale.set(size, size, 1);
    return sprite;
  },

  // ====================================================================
  // Runners
  // ====================================================================

  // The spots a runner visits, in order: its waypoints, or just where it sits.
  _pointsOf(runner) {
    return runner.path || [{ x: runner.x, midi: runner.midi }];
  },

  // Ticks between two pulses of a runner.
  _periodOf(runner) {
    return this._ticksPerBar / runner.d;
  },

  // Where a runner is, and which pulse of the pattern it is on, at a moment
  // of the pattern. Between pulses it glides in a straight line from the
  // waypoint it just played to the next, wrapping from the last to the first.
  _poseAt(runner, ticks) {
    const points = this._pointsOf(runner);
    const beat = ticks / this._periodOf(runner);
    const step = Math.floor(beat + 1e-6);

    const a = points[step % points.length];
    const b = points[(step + 1) % points.length];
    const f = Math.max(0, beat - step);
    const ya = this._yForMidi(a.midi), yb = this._yForMidi(b.midi);

    return { step, x: a.x + (b.x - a.x) * f, y: ya + (yb - ya) * f };
  },

  // A soft white disc for the bloom behind a runner.
  _glowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d');
    const fade = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, 'rgba(255, 255, 255, 1)');
    fade.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  },

  // A runner is a white disc with a bloom behind it.
  _buildRunnerViews() {
    this._ctx.util.disposeGroup(this._runnerGroup);
    const R = this._runnerRadius;

    for (const runner of this._runners) {
      const group = new THREE.Group();

      const glow = new THREE.Sprite(new THREE.SpriteMaterial(
        { map: this._glowTexture(), transparent: true, opacity: 0, depthTest: false }));
      glow.scale.set(R * 4.4, R * 4.4, 1);

      const core = new THREE.Mesh(new THREE.CircleGeometry(R, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      core.position.z = 0.02;

      group.add(glow, core);
      this._runnerGroup.add(group);
      runner.view = { group, glow, core };
    }
  },

  // The runner whose disc is under the pointer, wherever it has got to.
  _runnerAt(p) {
    for (let i = this._runners.length - 1; i >= 0; i--) {
      const r = this._runners[i];
      if (!r.shown) continue;   // scrolled out of the window

      const dx = p.x - r.px, dy = p.y - r.py;
      if (dx * dx + dy * dy <= this._runnerHit * this._runnerHit) return r;
    }
    return null;
  },

  _runnersChanged() {
    this._buildRunnerViews();
    this._buildPathViews();
    this._sendPattern();
    this._save();
  },

  _gcd(a, b) {
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  },

  _lcm(a, b) {
    return a / this._gcd(a, b) * b;
  },

  // Every runner's pulses, as one step pattern. The pattern is as long as it
  // takes all their cycles to come round together (a runner's cycle is one
  // pulse without a path, one pulse per waypoint with one). A pulse lands in
  // the step its moment falls in and is phrased later into that step by
  // however far past the boundary it is, so every rate, triplets included,
  // sits exactly where it should whatever the step size.
  _sendPattern() {
    const stepsPerBeat = this._ctx.getSubdivision().stepsPerBeat;
    const stepTicks = Math.max(1, Math.round(this._ticksPerBeat / stepsPerBeat));
    const longest = this._maxSteps * stepTicks;

    let total = stepTicks;
    for (const runner of this._runners) {
      total = this._lcm(total, this._periodOf(runner) * this._pointsOf(runner).length);
      if (total > longest) break;
    }

    // Cycles that only meet after more steps than the sequencer holds are cut
    // off at a whole number of bars; the runners that do not fit start over
    // from their first waypoint there.
    if (total > longest) {
      const bar = this._lcm(stepTicks, this._ticksPerBar);
      total = Math.max(stepTicks, Math.floor(longest / bar) * bar);
    }
    this._patternTicks = total;
    this._stepTicks = stepTicks;
    this._numSteps = total / stepTicks;
    this._heard.clear();

    const steps = [];
    for (let i = 0; i < this._numSteps; i++) steps.push([]);

    for (const runner of this._runners) {
      const points = this._pointsOf(runner);
      const period = this._periodOf(runner);

      for (let k = 0, t = 0; t < total; k++, t += period) {
        const point  = points[k % points.length];
        const note   = this._noteFor(point.midi);
        const chance = this._chanceAt(point.x);
        const index  = Math.floor(t / stepTicks);
        const delay  = Math.min(0.99, (t - index * stepTicks) / stepTicks);
        const step   = steps[index];

        // Two runners on the same note at the same moment are one note, as
        // likely as the likelier of them.
        const same = step.find(s => s.n === note && Math.abs(s.d - delay) < 1e-6);
        if (same) same.p = Math.max(same.p, chance);
        else if (step.length < this._maxNotesPerStep) step.push({ n: note, d: delay, p: chance });
      }
    }

    this._ctx.midi.setStepSequence(steps, this._gateMs, false);
  },

  onSubdivisionChange() {
    this._sendPattern();
  },

  // The sequencer reports each step as it plays it, with the notes that got
  // past the dice. Kept briefly so the runners can tell a hit from a miss.
  step(stepIndex, played) {
    const n = this._numSteps;
    this._heard.set(((stepIndex % n) + n) % n, { notes: played, at: this._now });
  },

  // Whether the hit a runner just made, at `ticks` into the pattern, sounded.
  // Without a fresh report for its step (the page was not being told, say)
  // only a certain note is taken to have played.
  _sounded(ticks, note, chance) {
    const report = this._heard.get(Math.floor(ticks / this._stepTicks + 1e-6));
    if (!report || this._now - report.at > 1) return chance >= 1;
    return report.notes.includes(note);
  },

  // ====================================================================
  // Paths
  // ====================================================================

  // A path is a faint line through its waypoints with a handle on each: the
  // two ends solid, the ones between hollow.
  _buildPathViews() {
    this._ctx.util.disposeGroup(this._pathGroup);
    this._pathViews = [];
    const r = this._handleRadius;

    for (const runner of this._runners) {
      if (!runner.path) continue;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position',
        new THREE.Float32BufferAttribute(new Float32Array((runner.path.length - 1) * 6), 3));
      const line = new THREE.LineSegments(geo,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      this._pathGroup.add(line);

      const handles = runner.path.map((q, i) => {
        const end = i === 0 || i === runner.path.length - 1;
        const mesh = new THREE.Mesh(
          end ? new THREE.CircleGeometry(r * 0.75, 24) : new THREE.RingGeometry(r - 1.5, r, 28),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
        mesh.position.z = 0.05;
        this._pathGroup.add(mesh);
        return mesh;
      });

      this._pathViews.push({ runner, line, handles });
    }

    this._layoutPaths();
  },

  // The part of a segment that lies inside the window, as [ax, ay, bx, by],
  // or null if none of it does. Paths can run off the top and bottom of the
  // window and must not be drawn over what is there.
  _clipToWindow(ax, ay, bx, by) {
    const half = this._rowHeight / 2;
    const lo = this._fieldBottom - half, hi = this._fieldTop + half;
    const dy = by - ay;
    let t0 = 0, t1 = 1;

    if (dy === 0) {
      if (ay < lo || ay > hi) return null;
    } else {
      const ta = (lo - ay) / dy, tb = (hi - ay) / dy;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 > t1) return null;
    }
    return [ax + (bx - ax) * t0, ay + dy * t0, ax + (bx - ax) * t1, ay + dy * t1];
  },

  // Put every path's line and handles where the current scroll has them.
  _layoutPaths() {
    for (const view of this._pathViews) {
      const path = view.runner.path;
      const attr = view.line.geometry.attributes.position;
      let n = 0;

      for (let i = 0; i + 1 < path.length; i++) {
        const seg = this._clipToWindow(path[i].x, this._yForMidi(path[i].midi),
                                       path[i + 1].x, this._yForMidi(path[i + 1].midi));
        if (!seg) continue;
        attr.setXYZ(n++, seg[0], seg[1], 0);
        attr.setXYZ(n++, seg[2], seg[3], 0);
      }
      attr.needsUpdate = true;
      view.line.geometry.setDrawRange(0, n);

      view.handles.forEach((mesh, i) => {
        const y = this._yForMidi(path[i].midi);
        const fade = this._edgeFade(y);
        mesh.visible = fade > 0;
        mesh.position.x = path[i].x;
        mesh.position.y = y;
        mesh.material.opacity = 0.85 * fade * (0.3 + 0.7 * this._chanceAt(path[i].x));
      });
    }
  },

  // The waypoint under the pointer, as { runner, index }.
  _handleAt(p) {
    for (let i = this._runners.length - 1; i >= 0; i--) {
      const runner = this._runners[i];
      if (!runner.path) continue;

      for (let j = 0; j < runner.path.length; j++) {
        const y = this._yForMidi(runner.path[j].midi);
        if (this._edgeFade(y) <= 0) continue;

        const dx = p.x - runner.path[j].x, dy = p.y - y;
        if (dx * dx + dy * dy <= this._handleHit * this._handleHit) return { runner, index: j };
      }
    }
    return null;
  },

  // ---- laying a path ----

  // Start laying (or extending) a runner's path. It begins with what the
  // runner already has: its waypoints, or the spot it sits on.
  _startLaying(runner) {
    this._closeRadial(true);
    this._laying = {
      runner,
      points: this._pointsOf(runner).map(q => ({ x: q.x, midi: q.midi })),
      pointer: null,
    };
    this._buildLayButtons();
    this._drawLaying();
  },

  // Done and cancel sit level with the top bar, at the right, clear of the field.
  _buildLayButtons() {
    const size = this._ctx.getSize();
    const r = this._layButtonRadius;
    const y = size.height - 28;

    this._layButtons = [
      { kind: 'cancel', icon: 'cross', color: 0xff5a5a, x: size.width - 36 - r * 2 - 12, y },
      { kind: 'done',   icon: 'tick',  color: 0xffffff, x: size.width - 36, y },
    ].map((b) => {
      const border = new THREE.Mesh(new THREE.CircleGeometry(r, 48),
        new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.6, depthTest: false }));
      const fill = new THREE.Mesh(new THREE.CircleGeometry(r - 1.5, 48),
        new THREE.MeshBasicMaterial({ color: 0x0e0e10, transparent: true, depthTest: false }));
      const text = this._makeIcon(b.icon);
      text.material.color.setHex(b.color);
      text.material.depthTest = false;
      border.renderOrder = 6;
      fill.renderOrder = 7;
      text.renderOrder = 8;

      const group = new THREE.Group();
      group.position.set(b.x, b.y, 0);
      group.add(border, fill, text);
      this._layButtonGroup.add(group);
      return { kind: b.kind, x: b.x, y: b.y };
    });
  },

  _layButtonAt(p) {
    const r = this._layButtonRadius + 4;
    return this._layButtons.find(b => (p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= r * r) || null;
  },

  // The path being laid: a line through the points so far, a dot on each, and
  // a lighter line out to the pointer showing where the next one would go.
  _drawLaying() {
    this._ctx.util.disposeGroup(this._layGroup);
    const laying = this._laying;
    if (!laying) return;

    const at = q => ({ x: q.x, y: this._yForMidi(q.midi) });
    const spots = laying.points.map(at);

    const pts = [];
    for (let i = 0; i + 1 < spots.length; i++) {
      const seg = this._clipToWindow(spots[i].x, spots[i].y, spots[i + 1].x, spots[i + 1].y);
      if (seg) pts.push(seg[0], seg[1], 0, seg[2], seg[3], 0);
    }
    if (pts.length) this._line(this._layGroup, pts, 0xffffff, 0.5);

    if (laying.pointer && laying.points.length < this._maxWaypoints) {
      const last = spots[spots.length - 1];
      const next = at(laying.pointer);
      const seg = this._clipToWindow(last.x, last.y, next.x, next.y);
      if (seg) this._line(this._layGroup, [seg[0], seg[1], 0, seg[2], seg[3], 0], 0xffffff, 0.2);
    }

    for (const spot of spots) {
      const fade = this._edgeFade(spot.y);
      if (fade <= 0) continue;

      const dot = new THREE.Mesh(new THREE.CircleGeometry(3.5, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 * fade }));
      dot.position.set(spot.x, spot.y, 0.1);
      this._layGroup.add(dot);
    }
  },

  // Stop laying. Kept, the points become the runner's path (two or more of
  // them; a single point is just the runner where it was).
  _finishLaying(keep) {
    const laying = this._laying;
    if (!laying) return;

    this._laying = null;
    this._layButtons = [];
    this._ctx.util.disposeGroup(this._layGroup);
    this._ctx.util.disposeGroup(this._layButtonGroup);
    this._ctx.setCursor('');

    if (keep && laying.points.length >= 2) {
      const runner = laying.runner;
      runner.path = laying.points;
      runner.x = runner.path[0].x;
      runner.midi = runner.path[0].midi;
      runner.lastPulse = null;
      this._runnersChanged();
    }
  },

  // ====================================================================
  // Ripples
  // ====================================================================

  _buildRipples() {
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2;
      pts.push(Math.cos(a), Math.sin(a), 0);
    }

    this._ripples = [];
    for (let i = 0; i < this._rippleCount; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const mesh = new THREE.LineLoop(geo,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
      mesh.visible = false;
      this._rippleGroup.add(mesh);
      this._ripples.push({ mesh, age: -1 });
    }
  },

  _shedRipple(x, y) {
    // The oldest ring is reused when none are free.
    let pick = this._ripples[0];
    for (const r of this._ripples) {
      if (r.age < 0) { pick = r; break; }
      if (r.age > pick.age) pick = r;
    }
    pick.age = 0;
    pick.mesh.position.set(x, y, 0);
    pick.mesh.visible = true;
  },

  _updateRipples(dt) {
    for (const r of this._ripples) {
      if (r.age < 0) continue;

      r.age += dt;
      if (r.age >= this._rippleLife) {
        r.age = -1;
        r.mesh.visible = false;
        continue;
      }
      const radius = this._runnerRadius + r.age * this._rippleSpeed;
      r.mesh.scale.set(radius, radius, 1);
      r.mesh.material.opacity = this._rippleAlpha * (1 - r.age / this._rippleLife);
    }
  },

  // ====================================================================
  // The clear button
  // ====================================================================

  // A small pill level with the top bar, at the right, where done and cancel
  // go while a path is being laid (it steps aside for them).
  _buildClearButton() {
    const size = this._ctx.getSize();
    const w = this._clearWidth, h = this._clearHeight;

    const border = new THREE.Mesh(this._capsule(w, h),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
    const fill = new THREE.Mesh(this._capsule(w - 3, h - 3),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
    const text = { width: 48, height: 16, font: '600 11px', align: 'center' };
    const label   = this._makeText('Clear', text);
    const confirm = this._makeText('Sure?', text);
    for (const sprite of [label, confirm]) sprite.material.depthTest = false;
    border.renderOrder = 6;
    fill.renderOrder = 7;
    label.renderOrder = confirm.renderOrder = 8;

    this._clearGroup.position.x = size.width - 21 - w / 2;
    this._clearGroup.position.y = size.height - 28;
    this._clearGroup.add(border, fill, label, confirm);
    this._clearGroup.visible = false;   // until there is something to clear

    this._clear = {
      x: this._clearGroup.position.x, y: this._clearGroup.position.y,
      border, fill, label, confirm, hover: false, armedUntil: 0,
    };
    this._styleClear();
  },

  _clearShowing() {
    return this._runners.length > 0 && !this._laying;
  },

  _overClear(p) {
    const c = this._clear;
    return this._clearShowing()
        && Math.abs(p.x - c.x) <= this._clearWidth / 2 + 3
        && Math.abs(p.y - c.y) <= this._clearHeight / 2 + 3;
  },

  // Quiet until pointed at; red once it has been clicked and is waiting to
  // be clicked again.
  _styleClear() {
    const c = this._clear;
    const armed = this._now < c.armedUntil;
    const accent = armed ? 0xff5a5a : 0xffffff;

    c.border.material.color.setHex(accent);
    c.border.material.opacity = armed ? 0.9 : (c.hover ? 0.6 : 0.3);
    c.fill.material.color.setHex(armed && c.hover ? 0xff5a5a : 0x0e0e10);
    c.fill.material.opacity = 0.96;
    c.label.visible = !armed;
    c.confirm.visible = armed;
    c.label.material.color.setHex(0xffffff);
    c.label.material.opacity = c.hover ? 0.9 : 0.55;
    c.confirm.material.color.setHex(c.hover ? 0x0a0a0a : 0xff5a5a);
  },

  // The first click arms it; a second, soon enough after, clears the canvas.
  _pressClear() {
    const c = this._clear;

    if (this._now < c.armedUntil) {
      c.armedUntil = 0;
      this._closeRadial(true);
      this._runners = [];
      this._runnersChanged();
    } else {
      c.armedUntil = this._now + this._clearConfirmSeconds;
    }
    this._styleClear();
  },

  _updateClear() {
    const c = this._clear;
    this._clearGroup.visible = this._clearShowing();

    // The wait for the second click running out.
    if (c.armedUntil && this._now >= c.armedUntil) {
      c.armedUntil = 0;
      this._styleClear();
    }
  },

  // ====================================================================
  // The radial
  // ====================================================================

  // What goes round the ring. Placing: the seven rates, with "1" at the
  // bottom-left and the rest running clockwise. On a runner: the same, with
  // a pencil (lay or extend its path) and a delete chip either side of the
  // bottom centre.
  _radialItems(editing) {
    const rates = this._subdivisions.map(s => ({ label: s.label, pick: s.d }));
    const controls = editing
      ? [{ label: '✎', pick: 'path' }, { label: '✕', pick: 'delete', danger: true }]
      : [];

    const total = rates.length + controls.length;
    const start = Math.round(total / 2 - controls.length / 2);   // bottom centre
    const ring = new Array(total);
    controls.forEach((c, k) => { ring[(start + k) % total] = c; });

    let slot = (start + controls.length) % total;
    for (const r of rates) {
      ring[slot] = r;
      slot = (slot + 1) % total;
    }
    return ring;
  },

  _capsule(width, height) {
    const r = height / 2, half = width / 2 - r;
    const shape = new THREE.Shape();
    shape.absarc( half, 0, r, -Math.PI / 2,  Math.PI / 2, false);
    shape.absarc(-half, 0, r,  Math.PI / 2, -Math.PI / 2, false);
    return new THREE.ShapeGeometry(shape, 16);
  },

  // Open the ring around (x, y). With a runner it edits that runner;
  // without, it is choosing the rate of one about to land there.
  _openRadial(x, y, target) {
    this._closeRadial(true);

    const size = this._ctx.getSize();
    const R = this._radialRadius;

    // Keep the whole ring on screen and clear of the top bar.
    const cx = Math.max(R + 36, Math.min(size.width - R - 36, x));
    const cy = Math.max(R + 28, Math.min(size.height - 60 - R - 28, y));

    const items = this._radialItems(!!target);
    const chips = items.map((item, i) => {
      // Slot 0 is straight up and they run clockwise.
      const angle = Math.PI / 2 - i * 2 * Math.PI / items.length;

      const border = new THREE.Mesh(this._capsule(this._chipWidth, this._chipHeight),
        new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
      const fill = new THREE.Mesh(this._capsule(this._chipWidth - 3, this._chipHeight - 3),
        new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
      const text = item.pick === 'delete'
        ? this._makeIcon('cross')
        : this._makeText(item.label,
            { width: 56, height: 24, font: typeof item.pick === 'number' ? '700 15px' : '700 18px', align: 'center' });
      text.material.depthTest = false;
      border.renderOrder = 10;
      fill.renderOrder = 11;
      text.renderOrder = 12;

      const group = new THREE.Group();
      group.add(border, fill, text);
      this._radialGroup.add(group);

      return {
        item, group, border, fill, text,
        tx: cx + R * Math.cos(angle),
        ty: cy + R * Math.sin(angle),
        a: 0, v: 0,                        // 0 = collapsed on the click, 1 = seated on the ring
        delay: i * this._staggerIn,
      };
    });

    // A hollow ring marks where the runner will land.
    let ghost = null;
    if (!target) {
      const r = this._runnerRadius;
      ghost = new THREE.Mesh(new THREE.RingGeometry(r - 1, r + 1, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false }));
      ghost.position.set(x, y, 0);
      ghost.renderOrder = 9;
      this._radialGroup.add(ghost);
    }

    this._radial = { x, y, target, chips, ghost, hover: -1, closing: false, age: 0, g: 0 };
    this._styleChips();
  },

  // Start the ring receding, or drop it at once.
  _closeRadial(immediately) {
    const radial = this._radial;
    if (!radial) return;

    if (immediately) {
      this._ctx.util.disposeGroup(this._radialGroup);
      this._radial = null;
      this._ctx.setCursor('');
      return;
    }

    radial.closing = true;
    radial.age = 0;
    radial.hover = -1;
    radial.chips.forEach((chip, i) => {
      chip.delay = (radial.chips.length - 1 - i) * this._staggerOut;
    });
    this._styleChips();
  },

  _chipAt(p) {
    const radial = this._radial;
    if (!radial || radial.closing) return -1;

    let best = -1, bestD = this._chipHit * this._chipHit;
    radial.chips.forEach((chip, i) => {
      const dx = p.x - chip.tx, dy = p.y - chip.ty;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = i; }
    });
    return best;
  },

  // Dark chips with a pale outline; the one under the pointer fills in.
  _styleChips() {
    const radial = this._radial;
    radial.chips.forEach((chip, i) => {
      const on = i === radial.hover;
      const accent = chip.item.danger ? 0xff5a5a : 0xffffff;

      chip.border.material.color.setHex(accent);
      chip.border.userData.alpha = on ? 1 : (chip.item.danger ? 0.75 : 0.5);
      chip.fill.material.color.setHex(on ? accent : 0x0e0e10);
      chip.fill.userData.alpha = on ? 1 : 0.96;
      chip.text.material.color.setHex(on ? 0x0a0a0a : accent);
    });
  },

  // Chips spring out from the click one after another, and recede in reverse.
  _updateRadial(dt) {
    const radial = this._radial;
    if (!radial) return;
    radial.age += dt;

    let settled = true;
    for (const chip of radial.chips) {
      if (radial.age >= chip.delay) {
        if (radial.closing) {
          chip.a = Math.max(0, chip.a - dt / 0.15);
          chip.v = 0;
        } else {
          const accel = (-200 * (chip.a - 1) - 13 * chip.v) / 0.7;
          chip.v += accel * dt;
          chip.a += chip.v * dt;
        }
      }
      if (chip.a > 0) settled = false;

      const a = Math.max(0, chip.a);
      const scale = 0.3 + 0.7 * a;
      chip.group.position.set(radial.x + (chip.tx - radial.x) * a, radial.y + (chip.ty - radial.y) * a, 0);
      chip.group.scale.set(scale, scale, 1);
      chip.border.material.opacity = Math.min(1, a) * chip.border.userData.alpha;
      chip.fill.material.opacity   = Math.min(1, a) * chip.fill.userData.alpha;
      chip.text.material.opacity   = Math.min(1, a);
    }

    if (radial.ghost) {
      radial.g = radial.closing ? Math.max(0, radial.g - dt / 0.15) : Math.min(1, radial.g + dt / 0.12);
      const s = 0.4 + 0.6 * radial.g;
      radial.ghost.scale.set(s, s, 1);
      radial.ghost.material.opacity = 0.55 * radial.g;
    }

    if (radial.closing && settled) this._closeRadial(true);
  },

  // A chip was chosen: land a runner, change one's rate, start its path, or
  // remove it.
  _choose(pick) {
    const radial = this._radial;
    const target = radial.target;

    if (pick === 'path') {
      this._startLaying(target);
      return;
    }

    if (target) {
      if (pick === 'delete') {
        this._runners = this._runners.filter(r => r !== target);
      } else {
        target.d = pick;
        target.lastPulse = null;
      }
    } else if (this._runners.length < this._maxRunners) {
      const spot = this._spotAt(radial);
      const runner = this._makeRunner(spot.x, spot.midi, pick, null);
      runner.pop = 1;
      this._runners.push(runner);
      this._shedRipple(radial.x, radial.y);
    }

    this._runnersChanged();
    this._closeRadial(false);
  },

  // ====================================================================
  // Input
  // ====================================================================

  onPointerDown(p, e) {
    if (e.button !== 0) return;

    // With the ring open or a path being laid, a press is only ever a click.
    const busy = this._laying || (this._radial && !this._radial.closing);
    const handle = busy ? null : this._handleAt(p);
    const runner = busy || handle ? null : this._runnerAt(p);
    this._press = { x: p.x, y: p.y, handle, runner, dragging: false, at: null };
  },

  // What a press on this could be dragged to do. Waypoints and runners
  // without a path go anywhere; a runner riding a path is moved by its
  // waypoints, not by its disc.
  _draggable(press) {
    return !!press.handle || (!!press.runner && !press.runner.path);
  },

  // Carry whatever is held to the pointer, and let the pattern follow. A
  // pointer past the window holds it on the edge row.
  _drag(press, p) {
    const spot = this._spotAt(p);

    const runner = press.handle ? press.handle.runner : press.runner;
    const point  = press.handle ? runner.path[press.handle.index] : runner;

    const sameNote = this._noteFor(point.midi) === spot.midi;
    if (sameNote && point.x === spot.x) return;

    point.x = spot.x;
    if (!sameNote) point.midi = spot.midi;
    if (press.handle && press.handle.index === 0) {
      runner.x = point.x;
      runner.midi = point.midi;
    }
    this._layoutPaths();
    this._sendPattern();
  },

  onPointerMove(p) {
    const press = this._press;

    if (this._laying) {
      const button = this._layButtonAt(p);
      this._laying.pointer = !button && this._inField(p) ? this._spotAt(p) : null;
      this._drawLaying();
      this._ctx.setCursor(button ? 'pointer' : (this._laying.pointer ? 'crosshair' : ''));
      return;
    }

    if (press && this._draggable(press)) {
      if (!press.dragging && Math.abs(p.x - press.x) + Math.abs(p.y - press.y) > 6) {
        press.dragging = true;
      }
      if (press.dragging) {
        press.at = { x: p.x, y: p.y };
        this._drag(press, p);
        this._ctx.setCursor('grabbing');
        return;
      }
    }

    this._hover(p);
  },

  _hover(p) {
    const overClear = this._overClear(p);
    if (overClear !== this._clear.hover) {
      this._clear.hover = overClear;
      this._styleClear();
    }
    if (overClear) {
      this._ctx.setCursor('pointer');
      return;
    }

    const radial = this._radial;

    if (radial && !radial.closing) {
      const hover = this._chipAt(p);
      if (hover !== radial.hover) {
        radial.hover = hover;
        this._styleChips();
      }
      this._ctx.setCursor(hover !== -1 ? 'pointer' : '');
      return;
    }

    const runner = this._handleAt(p) ? null : this._runnerAt(p);
    this._ctx.setCursor(this._handleAt(p) || (runner && !runner.path) ? 'grab' : (runner ? 'pointer' : ''));
  },

  onPointerUp(p) {
    const press = this._press;
    this._press = null;
    if (!press) return;

    if (press.dragging) {
      this._save();
      this._hover(p);
      return;
    }
    if (Math.abs(p.x - press.x) + Math.abs(p.y - press.y) > 6) return;

    // While a path is being laid, a click is done, cancel, or one more waypoint.
    if (this._laying) {
      const button = this._layButtonAt(p);
      if (button) {
        this._finishLaying(button.kind === 'done');
      } else if (this._inField(p) && this._laying.points.length < this._maxWaypoints) {
        const spot = this._spotAt(p);
        const last = this._laying.points[this._laying.points.length - 1];
        // The second click of a double-click is not a second waypoint.
        if (!(last.midi === spot.midi && Math.abs(last.x - spot.x) < 6)) {
          this._laying.points.push(spot);
          this._drawLaying();
        }
      }
      return;
    }

    if (this._overClear(p)) {
      this._pressClear();
      return;
    }

    // With the ring open, a click either picks a chip or dismisses it.
    if (this._radial && !this._radial.closing) {
      const hit = this._chipAt(p);
      if (hit !== -1) this._choose(this._radial.chips[hit].item.pick);
      else this._closeRadial(false);
      return;
    }

    const runner = press.handle ? press.handle.runner : press.runner;
    if (runner) {
      // The ring opens on what was clicked: the waypoint, or the runner's disc.
      const q = press.handle ? runner.path[press.handle.index] : null;
      this._openRadial(q ? q.x : runner.px, q ? this._yForMidi(q.midi) : runner.py, runner);
    } else if (this._inField(p)) {
      // A runner lands on the note's own line, wherever in its band the click was.
      const spot = this._spotAt(p);
      this._openRadial(spot.x, this._yForMidi(spot.midi), null);
    }
  },

  // Double-clicking a runner (or one of its waypoints) starts laying its path.
  onDoubleClick(p) {
    if (this._laying) return;

    const handle = this._handleAt(p);
    const runner = handle ? handle.runner : this._runnerAt(p);
    if (runner) this._startLaying(runner);
  },

  onPointerCancel() {
    // A drag that is cut short keeps what it had reached.
    if (this._press && this._press.dragging) this._save();
    this._press = null;
  },

  // While something is held in the outer half of the top or bottom row, or
  // beyond it, the field scrolls under it, faster the further out the
  // pointer is, so a drag can reach any note on the keyboard.
  _edgeScroll(dt) {
    const press = this._press;
    if (!press || !press.dragging || !press.at) return;

    const half  = this._rowHeight / 2;
    const above = press.at.y - (this._fieldTop - half);
    const below = (this._fieldBottom + half) - press.at.y;
    if (above <= 0 && below <= 0) return;

    const { min, max, perRow } = this._edgeScrollSpeed;
    const depth = Math.max(above, below) / this._rowHeight;
    const speed = Math.min(max, min + depth * perRow) * (above > 0 ? 1 : -1);

    if (this._scrollTo(this._scroll + speed * dt)) this._drag(press, press.at);
  },

  // ====================================================================
  // Frame
  // ====================================================================

  update(delta, transport) {
    const dt = Math.min(delta, 0.05);
    this._now += dt;
    this._edgeScroll(dt);

    const starting = transport.isPlaying && !this._wasPlaying;
    this._wasPlaying = transport.isPlaying;

    // 0 stopped, 1 playing, easing between the two.
    this._live += ((transport.isPlaying ? 1 : 0) - this._live) * Math.min(1, dt * 10);

    // Where in the pattern the transport is.
    const total = this._patternTicks;
    const ticks = ((transport.beatPosition * this._ticksPerBeat) % total + total) % total;

    for (const runner of this._runners) {
      const pose = this._poseAt(runner, ticks);

      // Stopped, a runner on a path goes back to wait at its first waypoint,
      // where its path begins, sliding there from wherever it had got to. It
      // would otherwise sit stranded part-way between two notes. Once there
      // it stays put on that waypoint, however the field is scrolled.
      if (!transport.isPlaying && runner.path) {
        const homeX = runner.path[0].x;
        const homeY = this._yForMidi(runner.path[0].midi);
        const k = runner.atHome || !runner.drawn ? 1 : Math.min(1, dt * 10);

        pose.x = runner.px + (homeX - runner.px) * k;
        pose.y = runner.py + (homeY - runner.py) * k;
        runner.atHome = Math.abs(homeX - pose.x) + Math.abs(homeY - pose.y) < 0.5;
      } else {
        runner.atHome = false;
      }
      runner.drawn = true;

      // A runner scrolled out of the window keeps playing; it just isn't drawn.
      const fade = this._edgeFade(pose.y);
      runner.px = pose.x;
      runner.py = pose.y;
      runner.shown = fade > 0;

      // A new pulse of its own is a hit, if the dice let it sound. Pulses
      // are counted along the whole timeline, not within the pattern: a
      // runner that pulses once per pattern is on the same step of it every
      // time, and would never be seen to move on.
      const pulses = transport.beatPosition * this._ticksPerBeat / this._periodOf(runner);
      const pulse  = Math.floor(pulses + 1e-6);

      // Playback that starts right on one of its pulses starts with a hit.
      if (starting && runner.lastPulse === pulse) {
        const sinceMs = (pulses - pulse) * this._periodOf(runner) / this._ticksPerBeat * 60000 / (transport.tempo || 120);
        if (sinceMs < 80) runner.lastPulse = pulse - 1;
      }

      if (transport.isPlaying && runner.lastPulse !== null && pulse !== runner.lastPulse) {
        const points = this._pointsOf(runner);
        const point  = points[pose.step % points.length];
        const hitAt  = pose.step * this._periodOf(runner);

        if (this._sounded(hitAt, this._noteFor(point.midi), this._chanceAt(point.x))) {
          runner.pop = 1;
          if (fade > 0) this._shedRipple(pose.x, pose.y);
        }
      }
      runner.lastPulse = pulse;

      runner.pop = Math.max(0, runner.pop - dt * 5);
      const s = 1 + 0.14 * runner.pop;
      const view = runner.view;
      view.group.visible = runner.shown;
      view.group.position.set(pose.x, pose.y, 0);
      view.group.scale.set(s, s, 1);
      // Stopped, every disc is the same dim grey: nothing is sounding, so
      // none should look more alive than another. Playing, a disc is as
      // solid as a note where it is would be likely, and fully lit for the
      // moment of a hit.
      const likely = 0.3 + 0.7 * this._chanceAt(pose.x) * this._live;
      view.core.material.opacity = fade * Math.min(1, likely + runner.pop);
      view.glow.material.opacity = fade * (0.2 * (likely - 0.3) + 0.45 * runner.pop);
    }

    this._updateRipples(dt);
    this._updateRadial(dt);
    this._updateClear();
  },

  // ====================================================================
  // Shell lifecycle
  // ====================================================================

  pause() {
    if (this._press && this._press.dragging) this._save();
    this._press = null;
    this._finishLaying(false);
    this._closeRadial(true);
    this._clear.armedUntil = 0;
    this._clear.hover = false;
    this._styleClear();
  },

  resume() {},

  destroy() {
    if (this._unsubscribeScale) this._unsubscribeScale();
  },
};

Shell.register(Exploration1Experiment);
