// ==========================================================================
// Scratch — a percussion pulse you pull on
//
// One circle sits in the middle. Click it to start (or stop) a single
// percussive note hitting on every step of the selected subdivision. Drag
// it away from the center and the pulse speeds up CONTINUOUSLY — no
// stepped levels — the further you pull, the faster it goes. Let go and
// it springs back, the rate gliding down with it.
//
// Two engines: at rest the C++ step sequencer plays the note on-grid.
// While displaced, a free-running JS oscillator takes over so the rate
// can be any value between 1× and the maximum, tempo-relative but not
// quantized. Handover happens both ways at the center.
// ==========================================================================

const ScratchExperiment = {
  id:          'scratch',
  name:        'Scratch',
  description: 'Pull a percussion pulse away from center to speed it up',

  // Longer steps make the ratchet levels audible as distinct rhythms
  subdivisions: ['1/2', '1/4', '1/8', '1/8T', '1/16'],

  _group: null,
  _context: null,
  _unsubscribeScale: null,
  _onPointerDown: null,
  _onPointerMove: null,
  _onPointerUp: null,
  _onPointerCancel: null,

  // --- Sound ---
  _note:     60,         // C3 in this project's naming (percussion — key-agnostic)
  _velocity: 100,
  _playing:  false,

  // Rate multiplier vs pull: 1× at center → _maxRatchet at full pull,
  // exponential so the speed-up feels even across the whole travel.
  _maxRatchet: 8,
  _ratchet:    1,        // current multiplier (continuous)
  _stepMult:   2,        // steps per beat, inferred from step() calls

  // Free-running engine (active while displaced from center)
  _free:       false,
  _freePhase:  0,        // 0..1, wraps on each hit
  _homeEps:    1.5,      // px — closer than this counts as "home"

  // --- Geometry / physics ---
  _radius:      42,
  _pullRange:   0,       // px of pull that reaches the finest level (set from size)
  _cx: 0, _cy: 0,        // anchor (center of the canvas)
  _x:  0, _y:  0,        // circle position
  _vx: 0, _vy: 0,
  _stiffness:   180,
  _damping:     14,

  _pressed:     false,
  _dragging:    false,
  _pressX:      0,
  _pressY:      0,
  _dragThreshold: 5,

  // --- Visuals ---
  _circle:      null,
  _anchor:      null,    // dashed ring marking home
  _tether:      null,    // line from anchor to circle while displaced
  _tetherGeo:   null,
  _label:       null,    // "×N" readout under the circle
  _labelCanvas: null,
  _labelTex:    null,
  _labelValue:  -1,
  _flash:       0,       // 1 → 0 pulse on each hit

  _bgColor:     new THREE.Color(0x111111),
  _idleColor:   new THREE.Color(0x333333),
  _liveColor:   new THREE.Color(0xdddddd),
  _flashColor:  new THREE.Color(0xffffff),
  _tmpColor:    new THREE.Color(),

  // ====================================================================
  // Lifecycle
  // ====================================================================

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    // Percussion — the key doesn't matter, but keep the hook so a future
    // pitched variant can rebuild here.
    this._unsubscribeScale = context.scale.onChange(() => {});

    this._rebuild();
    this._bindEvents();
  },

  _rebuild() {
    while (this._group.children.length) {
      var child = this._group.children[0];
      this._group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }

    var size = this._context.getSize();
    this._cx = size.width / 2;
    this._cy = size.height / 2 - 10;   // nudge below the top bar's visual weight
    this._x = this._cx;
    this._y = this._cy;
    this._vx = 0;
    this._vy = 0;
    this._pullRange = Math.min(size.width, size.height) * 0.36;

    // Home marker
    this._anchor = this._makeDashedRing(this._radius + 6, 0x444444);
    this._anchor.position.set(this._cx, this._cy, 0.1);
    this._group.add(this._anchor);

    // Tether (2 points, updated every frame)
    this._tetherGeo = new THREE.BufferGeometry();
    this._tetherGeo.setAttribute('position',
      new THREE.Float32BufferAttribute([0, 0, 0.2, 0, 0, 0.2], 3));
    var tetherMat = new THREE.LineBasicMaterial({
      color: 0x888888, transparent: true, opacity: 0
    });
    this._tether = new THREE.Line(this._tetherGeo, tetherMat);
    this._group.add(this._tether);

    // The circle
    var geo = new THREE.CircleGeometry(this._radius, 64);
    var mat = new THREE.MeshBasicMaterial({ color: this._idleColor.getHex() });
    this._circle = new THREE.Mesh(geo, mat);
    this._circle.position.set(this._x, this._y, 0.5);
    this._group.add(this._circle);

    // Division readout
    this._labelCanvas = document.createElement('canvas');
    this._labelCanvas.width  = 96;
    this._labelCanvas.height = 32;
    this._labelTex = new THREE.CanvasTexture(this._labelCanvas);
    var labelMat = new THREE.SpriteMaterial({ map: this._labelTex, transparent: true });
    this._label = new THREE.Sprite(labelMat);
    this._label.scale.set(72, 24, 1);
    this._label.visible = false;
    this._group.add(this._label);
    this._labelValue = -1;
  },

  _makeDashedRing(radius, color) {
    var segments = 72;
    var verts = [];
    for (var i = 0; i <= segments; i++) {
      var a = (i / segments) * Math.PI * 2;
      verts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    var mat = new THREE.LineDashedMaterial({
      color: color, transparent: true, opacity: 0.6, dashSize: 4, gapSize: 5
    });
    var ring = new THREE.LineLoop(geo, mat);
    ring.computeLineDistances();
    return ring;
  },

  _renderLabel(text) {
    if (text === this._labelValue) return;
    this._labelValue = text;
    var cx = this._labelCanvas.getContext('2d');
    cx.clearRect(0, 0, 96, 32);
    cx.font = 'bold 15px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = 'rgba(255,255,255,0.85)';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, 48, 16);
    this._labelTex.needsUpdate = true;
  },

  // ====================================================================
  // Engines
  // ====================================================================

  _gateMsForPeriod(periodMs) {
    return Math.max(8, Math.min(100, periodMs * 0.4));
  },

  _baseHz(transport) {
    return ((transport.tempo || 120) / 60) * this._stepMult;
  },

  // Quantized engine: one note per step, on-grid, run by the C++ sequencer.
  _sendSequence() {
    if (!this._playing || this._free) {
      this._context.midi.setStepSequence([], 50);
      return;
    }
    var stepMs = 1000 / this._baseHz(this._context.getTransport());
    this._context.midi.setStepSequence([this._note], this._gateMsForPeriod(stepMs));
  },

  // Hand off grid → free. Seed the phase from the transport so the first
  // free hit lands where the next on-grid hit would have.
  _enterFree(transport) {
    if (this._free) return;
    this._free = true;
    var beat = transport.beatPosition * this._stepMult;
    this._freePhase = beat - Math.floor(beat);
    this._context.midi.setStepSequence([], 50);
  },

  // Hand off free → grid. The sequencer picks up at the next boundary.
  _exitFree() {
    if (!this._free) return;
    this._free = false;
    this._sendSequence();
  },

  _ratchetForDisplacement(dist) {
    var norm = Math.max(0, Math.min(1, dist / this._pullRange));
    return Math.pow(this._maxRatchet, norm);
  },

  _hit(periodMs) {
    this._context.midi.sendNote(this._note, this._velocity, 1, this._gateMsForPeriod(periodMs));
    this._flash = 1.0;
  },

  _togglePlaying() {
    this._playing = !this._playing;
    this._sendSequence();
  },

  // The shell calls this at each subdivision boundary. We use it to learn
  // the step rate (base for the free engine, gate length for the grid) and
  // to pulse the visuals — the grid engine itself runs in C++.
  step(stepIndex) {
    var beat = this._context.getTransport().beatPosition;
    var candidates = [0.25, 0.5, 1, 2, 3, 4];
    var best = this._stepMult, bestErr = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var err = Math.abs(beat * candidates[i] - stepIndex);
      if (err < bestErr) { bestErr = err; best = candidates[i]; }
    }
    if (best !== this._stepMult) {
      this._stepMult = best;
      if (this._playing && !this._free) this._sendSequence();
    }
    if (this._playing && !this._free) this._flash = 1.0;
  },

  // ====================================================================
  // Input
  // ====================================================================

  _bindEvents() {
    var self = this;
    var canvas = this._context.renderer.domElement;
    this._onPointerDown   = function (e) { self._handlePointerDown(e); };
    this._onPointerMove   = function (e) { self._handlePointerMove(e); };
    this._onPointerUp     = function (e) { self._handlePointerUp(e); };
    this._onPointerCancel = function (e) { self._handlePointerCancel(e); };
    canvas.addEventListener('pointerdown',   this._onPointerDown);
    canvas.addEventListener('pointermove',   this._onPointerMove);
    canvas.addEventListener('pointerup',     this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
  },

  _unbindEvents() {
    var canvas = this._context.renderer.domElement;
    if (this._onPointerDown)   canvas.removeEventListener('pointerdown',   this._onPointerDown);
    if (this._onPointerMove)   canvas.removeEventListener('pointermove',   this._onPointerMove);
    if (this._onPointerUp)     canvas.removeEventListener('pointerup',     this._onPointerUp);
    if (this._onPointerCancel) canvas.removeEventListener('pointercancel', this._onPointerCancel);
  },

  _clientToWorld(e) {
    var rect = this._context.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: rect.height - (e.clientY - rect.top) };
  },

  _hitCircle(p) {
    var dx = p.x - this._x, dy = p.y - this._y;
    return dx * dx + dy * dy <= this._radius * this._radius;
  },

  _handlePointerDown(e) {
    if (e.button !== 0) return;
    var p = this._clientToWorld(e);
    if (!this._hitCircle(p)) return;
    this._pressed = true;
    this._dragging = false;
    this._pressX = p.x;
    this._pressY = p.y;
    try { this._context.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
    this._updateCursor(p);
  },

  _handlePointerMove(e) {
    var p = this._clientToWorld(e);

    if (this._pressed && !this._dragging) {
      var dx = p.x - this._pressX, dy = p.y - this._pressY;
      if (dx * dx + dy * dy > this._dragThreshold * this._dragThreshold) {
        this._dragging = true;
      }
    }

    if (this._dragging) {
      // Rubber-band: the circle follows the pointer but with resistance
      // that saturates at pullRange, so it can never be flung off-screen.
      var px = p.x - this._cx, py = p.y - this._cy;
      var pullDist = Math.sqrt(px * px + py * py);
      var disp = this._pullRange * Math.tanh(pullDist / this._pullRange);
      if (pullDist > 0.0001) {
        this._x = this._cx + (px / pullDist) * disp;
        this._y = this._cy + (py / pullDist) * disp;
      }
      this._vx = 0;
      this._vy = 0;
    }

    this._updateCursor(p);
  },

  _handlePointerUp(e) {
    if (!this._pressed) return;
    var wasDrag = this._dragging;
    this._pressed = false;
    this._dragging = false;
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}

    if (!wasDrag) this._togglePlaying();
    // On drag release the spring in update() takes over.
    this._updateCursor(this._clientToWorld(e));
  },

  _handlePointerCancel(e) {
    this._pressed = false;
    this._dragging = false;
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}
    this._updateCursor(null);
  },

  _updateCursor(p) {
    var canvas = this._context.renderer.domElement;
    if (this._dragging)               canvas.style.cursor = 'grabbing';
    else if (p && this._hitCircle(p)) canvas.style.cursor = 'grab';
    else                              canvas.style.cursor = '';
  },

  // ====================================================================
  // Frame update
  // ====================================================================

  update(delta, transport) {
    if (!this._circle) return;
    var dt = Math.min(delta, 0.05);

    // Spring home when not being held
    if (!this._dragging) {
      var ax = -(this._x - this._cx) * this._stiffness - this._vx * this._damping;
      var ay = -(this._y - this._cy) * this._stiffness - this._vy * this._damping;
      this._vx += ax * dt;
      this._vy += ay * dt;
      this._x += this._vx * dt;
      this._y += this._vy * dt;
      var dx0 = this._x - this._cx, dy0 = this._y - this._cy;
      if (dx0 * dx0 + dy0 * dy0 < 0.05 && this._vx * this._vx + this._vy * this._vy < 0.5) {
        this._x = this._cx; this._y = this._cy; this._vx = 0; this._vy = 0;
      }
    }

    // Displacement drives the rate — continuously, and on the way home
    // too, so a release glides back down instead of snapping to 1×.
    var dx = this._x - this._cx, dy = this._y - this._cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    this._ratchet = this._ratchetForDisplacement(dist);

    // Engine handover tracks position regardless of play state, so a
    // pulse stopped mid-pull still comes back on the grid when restarted.
    var displaced = this._dragging || dist > this._homeEps;
    if (displaced) this._enterFree(transport);
    else           this._exitFree();

    // Free engine: advance phase at the current rate, fire on wrap.
    // At most one hit per frame — stacking several identical note-ons in
    // one frame would just be noise.
    if (this._playing && this._free && transport.isPlaying) {
      var hz = this._baseHz(transport) * this._ratchet;
      this._freePhase += hz * dt;
      if (this._freePhase >= 1) {
        this._freePhase -= Math.floor(this._freePhase);
        this._hit(1000 / hz);
      }
    }
    this._flash = Math.max(0, this._flash - dt * 10);

    // --- Draw ---
    var dim = this._context.scene.userData.dimFactor ?? 1.0;

    this._circle.position.set(this._x, this._y, 0.5);
    var pulse = 1 + this._flash * 0.08;
    this._circle.scale.set(pulse, pulse, 1);

    var base = this._playing ? this._liveColor : this._idleColor;
    this._tmpColor.copy(base).lerp(this._flashColor, this._flash);
    if (this._playing) this._tmpColor.lerp(this._bgColor, 1 - dim);
    this._circle.material.color.copy(this._tmpColor);

    var pos = this._tetherGeo.attributes.position;
    pos.setXYZ(0, this._cx, this._cy, 0.2);
    pos.setXYZ(1, this._x, this._y, 0.2);
    pos.needsUpdate = true;
    this._tether.material.opacity = Math.min(1, dist / 40) * 0.6;
    this._anchor.material.opacity = 0.25 + Math.min(1, dist / 40) * 0.45;

    var showLabel = this._ratchet > 1.02;
    this._label.visible = showLabel;
    if (showLabel) {
      this._renderLabel('×' + this._ratchet.toFixed(1));
      this._label.position.set(this._x, this._y - this._radius - 18, 0.6);
    }
  },

  // ====================================================================
  // Shell lifecycle
  // ====================================================================

  pause() {
    this._unbindEvents();
    this._pressed = false;
    this._dragging = false;
    this._context.renderer.domElement.style.cursor = '';
    // The sequencer is shared — hand it back empty
    this._context.midi.setStepSequence([], 50);
  },

  resume() {
    this._bindEvents();
    this._free = false;
    this._x = this._cx; this._y = this._cy; this._vx = 0; this._vy = 0;
    if (this._playing) this._sendSequence();
  },

  destroy() {
    this._unbindEvents();
    this._context.midi.setStepSequence([], 50);
    if (this._unsubscribeScale) this._unsubscribeScale();
    if (this._group && this._group.parent) this._group.parent.remove(this._group);
  },
};

Shell.register(ScratchExperiment);
