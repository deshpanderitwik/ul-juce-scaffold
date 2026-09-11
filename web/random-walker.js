// ==========================================================================
// Random Walker — a dot wanders the scale, one step per subdivision
//
// The notes of the current key are laid out left→right across two octaves
// starting at the shell's octave. Every step the dot moves up or down one
// scale degree (occasionally stays put), bouncing off the bounds.
//
// The walk is precomputed into a 128-step ring handed to the C++ step
// sequencer, so hits are sample-accurate. Whichever half of the ring is
// NOT playing is regenerated as a continuation of the other half, so the
// walk never audibly repeats and edits never touch the sounding step.
// ==========================================================================

const RandomWalkerExperiment = {
  id:          'random-walker',
  name:        'Random Walker',
  description: 'A dot random-walks the scale across two octaves',

  subdivisions: ['1/2', '1/4', '1/8', '1/8T', '1/16'],

  _group: null,
  _context: null,
  _unsubscribeScale: null,

  // --- Walk ---
  _notes:     [],        // MIDI notes, low → high, two octaves + top root
  _ring:      [],        // note indices, length _ringLen
  _ringLen:   128,
  _pos:       0,         // index into _notes for the most recent hit
  _lastStep:  -1,        // absolute step index of the last step() call
  _pStay:     0.12,      // chance of repeating the same note
  _pLeap:     0.10,      // chance a move is two degrees instead of one
  _gateMs:    150,

  // --- Layout ---
  _sideMargin:   60,
  _markerRadius: 3,
  _dotRadius:    14,
  _topBarHeight: 50,

  // --- Visuals ---
  _markers:   [],        // { mesh, label, x, isRoot }
  _dot:       null,
  _dotX:      0,         // eased x
  _dotTarget: 0,
  _trail:     [],        // { mesh, life }
  _flash:     0,

  _bgColor:      new THREE.Color(0x111111),
  _markerColor:  new THREE.Color(0x3a3a3a),
  _rootColor:    new THREE.Color(0x666666),
  _dotColor:     new THREE.Color(0xffffff),
  _tmpColor:     new THREE.Color(),

  // ====================================================================
  // Lifecycle
  // ====================================================================

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._unsubscribeScale = context.scale.onChange(() => this._rebuild());
    this._rebuild();
  },

  _rebuild() {
    this._clearScene();

    var scale = this._context.scale;
    var base  = scale.getBaseOctave();
    var low   = scale.getNoteForDegree(1, base);
    var high  = scale.getNoteForDegree(1, base + 2);
    this._notes = scale.getNotesInRange(low, high);

    this._pos = Math.max(0, Math.min(this._notes.length - 1, this._pos));
    this._buildMarkers();
    this._buildDot();

    // Whole ring from the current position — the sounding step may change
    // here, but a key change is exactly when that should happen.
    this._fillRing(0, this._ringLen, this._pos);
    this._sendRing();
  },

  _clearScene() {
    while (this._group.children.length) {
      var child = this._group.children[0];
      this._group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
    this._markers = [];
    this._trail   = [];
    this._dot     = null;
  },

  _xForIndex(i) {
    var w = this._context.getSize().width;
    var n = this._notes.length;
    if (n <= 1) return w / 2;
    return this._sideMargin + (i / (n - 1)) * (w - this._sideMargin * 2);
  },

  _laneY() {
    var h = this._context.getSize().height;
    return (h - this._topBarHeight) / 2 + 10;
  },

  _buildMarkers() {
    var y = this._laneY();
    var scale = this._context.scale;
    for (var i = 0; i < this._notes.length; i++) {
      var x = this._xForIndex(i);
      var isRoot = scale.getScaleDegree(this._notes[i]) === 1;
      var r = isRoot ? this._markerRadius + 1.5 : this._markerRadius;

      var geo  = new THREE.CircleGeometry(r, 24);
      var mat  = new THREE.MeshBasicMaterial({ color: isRoot ? this._rootColor : this._markerColor });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, 0.1);
      this._group.add(mesh);

      var label = this._makeLabel(scale.getNoteName(this._notes[i]), isRoot ? 0.6 : 0.3);
      label.position.set(x, y - 26, 0.1);
      this._group.add(label);

      this._markers.push({ mesh: mesh, label: label, x: x, isRoot: isRoot });
    }
  },

  _buildDot() {
    var geo = new THREE.CircleGeometry(this._dotRadius, 48);
    var mat = new THREE.MeshBasicMaterial({ color: this._dotColor.getHex() });
    this._dot = new THREE.Mesh(geo, mat);
    this._dotX = this._dotTarget = this._xForIndex(this._pos);
    this._dot.position.set(this._dotX, this._laneY(), 0.5);
    this._group.add(this._dot);
  },

  _makeLabel(text, alpha) {
    var c  = document.createElement('canvas');
    c.width = 64; c.height = 24;
    var cx = c.getContext('2d');
    cx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, 32, 12);
    var tex = new THREE.CanvasTexture(c);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(64, 24, 1);
    return spr;
  },

  // ====================================================================
  // Walk generation
  // ====================================================================

  _nextIndex(from) {
    var n = this._notes.length;
    if (n <= 1) return 0;
    if (Math.random() < this._pStay) return from;
    var size = Math.random() < this._pLeap ? 2 : 1;
    var dir  = Math.random() < 0.5 ? -1 : 1;
    var to   = from + dir * size;
    // Bounce off the edges
    if (to < 0)  to = -to;
    if (to >= n) to = 2 * (n - 1) - to;
    return Math.max(0, Math.min(n - 1, to));
  },

  // Fill ring[start, end) as a walk continuing from `from`.
  _fillRing(start, end, from) {
    if (this._ring.length !== this._ringLen) {
      this._ring = new Array(this._ringLen).fill(from);
    }
    var cur = from;
    for (var i = start; i < end; i++) {
      cur = this._nextIndex(cur);
      this._ring[i] = cur;
    }
  },

  _sendRing() {
    var self = this;
    var notes = this._ring.map(function (idx) { return self._notes[idx]; });
    this._context.midi.setStepSequence(notes, this._gateMs);
  },

  // ====================================================================
  // Quantized hook — visuals + ring maintenance. Sound is already handled
  // by the C++ sequencer reading the ring.
  // ====================================================================

  step(stepIndex) {
    var half = this._ringLen / 2;
    var slot = ((stepIndex % this._ringLen) + this._ringLen) % this._ringLen;

    // Entering a half: regenerate the OTHER half as a continuation of the
    // end of this one. The sounding slot is untouched, so no glitch.
    if (this._lastStep === -1 || slot === 0 || slot === half) {
      if (slot < half) this._fillRing(half, this._ringLen, this._ring[half - 1]);
      else             this._fillRing(0, half, this._ring[this._ringLen - 1]);
      this._sendRing();
    }
    this._lastStep = stepIndex;

    this._pos = this._ring[slot];
    this._dotTarget = this._xForIndex(this._pos);
    this._flash = 1.0;
    this._spawnTrail();
  },

  _spawnTrail() {
    var geo  = new THREE.CircleGeometry(this._dotRadius * 0.8, 32);
    var mat  = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(this._dotX, this._laneY(), 0.3);
    this._group.add(mesh);
    this._trail.push({ mesh: mesh, life: 1.0 });
  },

  // ====================================================================
  // Frame update
  // ====================================================================

  update(delta, transport) {
    if (!this._dot) return;
    var dt  = Math.min(delta, 0.05);
    var dim = this._context.scene.userData.dimFactor ?? 1.0;

    // Ease the dot toward its target
    this._dotX += (this._dotTarget - this._dotX) * Math.min(1, dt * 18);
    this._dot.position.x = this._dotX;
    this._flash = Math.max(0, this._flash - dt * 8);
    var s = 1 + this._flash * 0.25;
    this._dot.scale.set(s, s, 1);
    this._tmpColor.copy(this._dotColor).lerp(this._bgColor, (1 - dim) * 0.8);
    this._dot.material.color.copy(this._tmpColor);

    // Markers dim with transport too
    for (var i = 0; i < this._markers.length; i++) {
      var m = this._markers[i];
      var baseColor = m.isRoot ? this._rootColor : this._markerColor;
      this._tmpColor.copy(baseColor).lerp(this._bgColor, (1 - dim) * 0.6);
      m.mesh.material.color.copy(this._tmpColor);
    }

    // Trail fades out
    for (var t = this._trail.length - 1; t >= 0; t--) {
      var tr = this._trail[t];
      tr.life -= dt * 1.6;
      if (tr.life <= 0) {
        this._group.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        tr.mesh.material.dispose();
        this._trail.splice(t, 1);
      } else {
        tr.mesh.material.opacity = 0.35 * tr.life;
        var ts = 0.8 * tr.life;
        tr.mesh.scale.set(ts, ts, 1);
      }
    }
  },

  // ====================================================================
  // Shell lifecycle
  // ====================================================================

  pause() {
    this._context.midi.setStepSequence([], this._gateMs);
  },

  resume() {
    this._lastStep = -1;
    this._sendRing();
  },

  destroy() {
    this._context.midi.setStepSequence([], this._gateMs);
    if (this._unsubscribeScale) this._unsubscribeScale();
    this._clearScene();
    if (this._group && this._group.parent) this._group.parent.remove(this._group);
  },
};

Shell.register(RandomWalkerExperiment);
