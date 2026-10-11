// ==========================================================================
// Scale Flick — select a slice of the scale, arp it, flick it faster
//
// The ruler from Random Walker: two octaves of the current key, left→right.
//
//   • Drag horizontally across the ruler to select a range. The selected
//     notes arpeggiate upward, one per step, on the grid.
//   • Grab the selection and lift it. The arp speeds up continuously with
//     height (same engine as Scratch); let go and it ramps back down to
//     the selected subdivision.
//   • Click a note inside the selection to drop it from the arp (click
//     again to bring it back). Click outside the selection to clear it.
//
// Grid playback runs in the C++ sequencer; lifted playback is a
// free-running oscillator so the rate isn't quantized. Handover at both
// ends keeps the arp order continuous.
// ==========================================================================

const ScaleFlickExperiment = {
  id:          'scale-flick',
  name:        'Scale Flick',
  description: 'Select a slice of the scale, arp it, lift it to speed up',

  subdivisions: ['1/2', '1/4', '1/8', '1/8T', '1/16'],

  _group: null,
  _context: null,
  _unsubscribeScale: null,

  // --- Ruler ---
  _notes:        [],     // MIDI notes, low → high, two octaves + top root
  _markers:      [],     // { mesh, label, x, isRoot }
  _sideMargin:   60,
  _markerRadius: 3,
  _topBarHeight: 50,

  // --- Selection (inclusive indices into _notes; -1 = none) ---
  _selStart:  -1,
  _selEnd:    -1,
  _disabled:  {},        // note index → true when dropped from the arp
  _band:      null,      // highlight plane behind the selected markers
  _bandPad:   14,
  _bandHalfH: 24,

  // --- Pointer ---
  _pressed:       false,
  _pressMode:     '',    // 'select' (started off the band) | 'band' (on it)
  _dragging:      false,
  _pressX:        0,
  _pressY:        0,
  _dragThreshold: 5,
  _selAnchor:     -1,    // note index where a selection drag began
  _liftGrab:      0,     // pointer y minus band y at grab

  // --- Lift → rate ---
  _lift:       0,        // px above home
  _liftRange:  0,        // px of lift that reaches _maxRatchet (from size)
  _maxRatchet: 8,
  _ratchet:    1,
  _rampSec:    2.0,      // full lift → home
  _homeEps:    1.5,

  // --- Engines ---
  _rot:       0,         // seq[k] = arp[(k + rot) % len]; saved, see _saveState
  _gateSent:  null,      // gate (ms) of the last grid sequence sent; saved with rot
  _gateRate:  null,      // steps per beat that gate was computed for; saved with it
  _curIdx:    -1,        // arp position of the most recent hit
  _free:      false,
  _freePhase: 0,
  _freeIdx:   0,         // next arp position the free engine will play
  _gateFrac:  0.55,
  _velocity:  100,

  // --- Visuals ---
  _flashIdx:    -1,      // note index lit by the last hit
  _flash:       0,
  _label:       null,
  _labelCanvas: null,
  _labelTex:    null,
  _labelValue:  '',

  _bgColor:       new THREE.Color(0x111111),
  _markerColor:   new THREE.Color(0x3a3a3a),
  _rootColor:     new THREE.Color(0x666666),
  _selColor:      new THREE.Color(0xcccccc),
  _dropColor:     new THREE.Color(0x262626),
  _hitColor:      new THREE.Color(0xffffff),
  _tmpColor:      new THREE.Color(),

  // ====================================================================
  // Lifecycle
  // ====================================================================

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._unsubscribeScale = context.scale.onChange(() => this._rebuild());
    this._rebuild();

    var self = this;
    context.store.load(function (saved) {
      // Without a saved rotation the arp starts from the bottom
      var hasRot = !!saved && typeof saved.rot === 'number' && isFinite(saved.rot);
      self._restoreState(saved);
      self._rebuildBand();
      if (!hasRot) self._restartFromBottom();
      // The saved gate belongs to the rate it was computed for; at another
      // rate it has to be derived again.
      var sameRate = self._gateRate === self._stepsPerBeat();
      self._sendSequence(hasRot && sameRate ? self._gateSent : null);
    });
  },

  _restoreState(s) {
    if (!s) return;
    var n = this._notes.length;
    if (typeof s.selStart === 'number' && typeof s.selEnd === 'number'
        && s.selStart >= 0 && s.selEnd >= s.selStart && s.selEnd < n) {
      this._selStart = s.selStart;
      this._selEnd   = s.selEnd;
    }
    this._disabled = {};
    if (Array.isArray(s.disabled)) {
      for (var i = 0; i < s.disabled.length; i++) {
        var d = s.disabled[i];
        if (typeof d === 'number' && d >= 0 && d < n) this._disabled[d] = true;
      }
    }
    if (typeof s.rot === 'number' && isFinite(s.rot)) this._rot = Math.round(s.rot);
    this._gateSent = (typeof s.gate === 'number' && isFinite(s.gate)) ? s.gate : null;
    this._gateRate = (typeof s.gateRate === 'number' && isFinite(s.gateRate)) ? s.gateRate : null;
  },

  // The rotation and gate are saved with the selection: C++ keeps playing the
  // sequence it was given while the window is closed, and the window rebuilds
  // that same sequence when it opens. A rotation recomputed from the transport
  // position, or a gate recomputed from the tempo, at that moment would be a
  // different sequence.
  _saveState() {
    var disabled = [];
    for (var k in this._disabled) if (this._disabled[k]) disabled.push(parseInt(k, 10));
    this._context.store.save({
      selStart: this._selStart, selEnd: this._selEnd, disabled: disabled, rot: this._rot,
      gate: this._gateSent, gateRate: this._gateRate
    });
  },

  _rebuild() {
    this._clearScene();

    var scale = this._context.scale;
    var base  = scale.getBaseOctave();
    var low   = scale.getNoteForDegree(1, base);
    var high  = scale.getNoteForDegree(1, base + 2);
    this._notes = scale.getNotesInRange(low, high);

    var size = this._context.getSize();
    this._liftRange = Math.max(80, this._laneY() - this._topBarHeight - 40);

    // Keep the selection where the layout allows
    var n = this._notes.length;
    if (this._selEnd >= n) this._selEnd = n - 1;
    if (this._selStart > this._selEnd) { this._selStart = -1; this._selEnd = -1; }
    for (var k in this._disabled) if (parseInt(k, 10) >= n) delete this._disabled[k];

    this._buildMarkers();
    this._buildLabel();
    this._rebuildBand();

    this._restartFromBottom();
    this._sendSequence();
    this._saveState();
  },

  _clearScene() {
    this._context.util.disposeGroup(this._group);
    this._markers = [];
    this._band    = null;
    this._label   = null;
  },

  _xForIndex(i) {
    var w = this._context.getSize().width;
    var n = this._notes.length;
    if (n <= 1) return w / 2;
    return this._sideMargin + (i / (n - 1)) * (w - this._sideMargin * 2);
  },

  _spacing() {
    var n = this._notes.length;
    return n > 1 ? this._xForIndex(1) - this._xForIndex(0) : 40;
  },

  _laneY() {
    var h = this._context.getSize().height;
    return (h - this._topBarHeight) / 2 - 20;
  },

  _buildMarkers() {
    var y = this._laneY();
    var scale = this._context.scale;
    for (var i = 0; i < this._notes.length; i++) {
      var x = this._xForIndex(i);
      var isRoot = scale.getScaleDegree(this._notes[i]) === 1;
      var r = isRoot ? this._markerRadius + 1.5 : this._markerRadius;

      var geo  = new THREE.CircleGeometry(r, 24);
      var mat  = new THREE.MeshBasicMaterial({ color: 0xffffff });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, 0.2);
      this._group.add(mesh);

      var label = this._makeLabel(scale.getNoteName(this._notes[i]));
      label.position.set(x, y - 26, 0.2);
      this._group.add(label);

      this._markers.push({ mesh: mesh, label: label, x: x, isRoot: isRoot });
    }
  },

  _makeLabel(text) {
    var c  = document.createElement('canvas');
    c.width = 64; c.height = 24;
    var cx = c.getContext('2d');
    cx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = '#ffffff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, 32, 12);
    var tex = new THREE.CanvasTexture(c);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.4 }));
    spr.scale.set(64, 24, 1);
    return spr;
  },

  _buildLabel() {
    this._labelCanvas = document.createElement('canvas');
    this._labelCanvas.width  = 96;
    this._labelCanvas.height = 32;
    this._labelTex = new THREE.CanvasTexture(this._labelCanvas);
    this._label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._labelTex, transparent: true }));
    this._label.scale.set(72, 24, 1);
    this._label.visible = false;
    this._group.add(this._label);
    this._labelValue = '';
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

  _hasSelection() {
    return this._selStart >= 0 && this._selEnd >= this._selStart;
  },

  _rebuildBand() {
    if (this._band) {
      this._group.remove(this._band);
      this._context.util.disposeObject(this._band);
      this._band = null;
    }
    if (!this._hasSelection()) return;

    var x0 = this._xForIndex(this._selStart) - this._bandPad;
    var x1 = this._xForIndex(this._selEnd)   + this._bandPad;
    var geo = new THREE.PlaneGeometry(x1 - x0, this._bandHalfH * 2);
    var mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 });
    this._band = new THREE.Mesh(geo, mat);
    this._band.position.set((x0 + x1) / 2, this._laneY() + this._lift, 0.05);
    this._group.add(this._band);
  },

  // ====================================================================
  // Arp list + engines
  // ====================================================================

  // Note indices in the selection that are still enabled, ascending.
  _arp() {
    var out = [];
    if (!this._hasSelection()) return out;
    for (var i = this._selStart; i <= this._selEnd; i++) {
      if (!this._disabled[i]) out.push(i);
    }
    return out;
  },

  _mod(a, n) { return ((a % n) + n) % n; },

  _stepsPerBeat() {
    return this._context.getSubdivision().stepsPerBeat;
  },

  // The grid step that will sound next. Once C++ has reported a step that is
  // the one after it; before that (transport stopped, rate just changed) the
  // first boundary at or after the transport position.
  _nextStep() {
    var last = this._context.getStepIndex();
    if (last !== -1) return last + 1;
    return Math.ceil(this._context.getTransport().beatPosition * this._stepsPerBeat());
  },

  _baseHz(transport) {
    return ((transport.tempo || 120) / 60) * this._stepsPerBeat();
  },

  _gateMs(periodMs) {
    return Math.max(10, Math.min(300, periodMs * this._gateFrac));
  },

  // Rotate so the NEXT grid step plays arp[idx]
  _continueFrom(idx) {
    var len = this._arp().length;
    this._rot = len > 0 ? this._mod(idx - this._nextStep(), len) : 0;
  },

  _restartFromBottom() {
    this._continueFrom(0);
    this._curIdx = -1;
  },

  // gateMs overrides the gate derived from the live tempo, so a sequence can be
  // re-sent exactly as it was last sent.
  _sendSequence(gateMs) {
    var arp = this._arp();
    if (this._free || arp.length === 0) {
      this._context.midi.setStepSequence([], 50);
      return;
    }
    var seq = [];
    for (var k = 0; k < arp.length; k++) {
      seq.push(this._notes[arp[this._mod(k + this._rot, arp.length)]]);
    }
    if (typeof gateMs !== 'number') {
      gateMs = this._gateMs(1000 / this._baseHz(this._context.getTransport()));
      this._gateRate = this._stepsPerBeat();
    }
    this._gateSent = gateMs;
    this._context.midi.setStepSequence(seq, gateMs);
  },

  _enterFree(transport) {
    if (this._free) return;
    this._free = true;
    var len = this._arp().length;
    this._freeIdx = len > 0 ? this._mod(this._curIdx + 1, len) : 0;
    var beat = transport.beatPosition * this._stepsPerBeat();
    this._freePhase = beat - Math.floor(beat);
    this._context.midi.setStepSequence([], 50);
  },

  _exitFree() {
    if (!this._free) return;
    this._free = false;
    this._continueFrom(this._freeIdx);
    this._curIdx = this._freeIdx - 1;   // so the next grid hit reads as freeIdx
    this._sendSequence();
    this._saveState();
  },

  _freeHit(periodMs) {
    var arp = this._arp();
    if (arp.length === 0) return;
    if (this._freeIdx >= arp.length) this._freeIdx = 0;
    var noteIdx = arp[this._freeIdx];
    this._context.midi.sendNote(this._notes[noteIdx], this._velocity, 1, this._gateMs(periodMs));
    this._curIdx  = this._freeIdx;
    this._freeIdx = (this._freeIdx + 1) % arp.length;
    this._flashIdx = noteIdx;
    this._flash = 1.0;
  },

  // After the arp list changes, keep going from the next note above the
  // one that just sounded (wrapping to the bottom).
  _reconcileArp(prevNoteIdx) {
    var arp = this._arp();
    var next = 0;
    for (var i = 0; i < arp.length; i++) {
      if (arp[i] > prevNoteIdx) { next = i; break; }
    }
    if (this._free) {
      this._freeIdx = next;
    } else {
      this._continueFrom(next);
      this._curIdx = next - 1;
    }
    this._sendSequence();
  },

  _currentNoteIdx() {
    var arp = this._arp();
    if (this._curIdx >= 0 && this._curIdx < arp.length) return arp[this._curIdx];
    return -1;
  },

  step(stepIndex, played) {
    if (this._free) return;
    var arp = this._arp();
    if (arp.length === 0) return;
    this._curIdx   = this._mod(stepIndex + this._rot, arp.length);
    this._flashIdx = arp[this._curIdx];
    this._flash    = 1.0;
  },

  onSubdivisionChange(sub) {
    // The gate follows the step period
    if (this._free) return;
    this._sendSequence();
    this._saveState();
  },

  // ====================================================================
  // Input
  // ====================================================================

  // Nearest marker to x, or -1 if the pointer is off the ruler's ends
  _indexAtX(x) {
    var n = this._notes.length;
    if (n === 0) return -1;
    var i = Math.round((x - this._sideMargin) / this._spacing());
    return Math.max(0, Math.min(n - 1, i));
  },

  _onBand(p) {
    if (!this._hasSelection()) return false;
    var x0 = this._xForIndex(this._selStart) - this._bandPad;
    var x1 = this._xForIndex(this._selEnd)   + this._bandPad;
    var y  = this._laneY() + this._lift;
    return p.x >= x0 && p.x <= x1 && Math.abs(p.y - y) <= this._bandHalfH;
  },

  onPointerDown(p, e) {
    if (e.button !== 0) return;
    this._pressed  = true;
    this._dragging = false;
    this._pressX = p.x;
    this._pressY = p.y;

    if (this._onBand(p)) {
      this._pressMode = 'band';
      this._liftGrab  = p.y - (this._laneY() + this._lift);
    } else {
      this._pressMode = 'select';
      this._selAnchor = this._indexAtX(p.x);
    }
    this._updateCursor(p);
  },

  onPointerMove(p, e) {
    if (this._pressed && !this._dragging) {
      var dx = p.x - this._pressX, dy = p.y - this._pressY;
      if (dx * dx + dy * dy > this._dragThreshold * this._dragThreshold) {
        this._dragging = true;
        if (this._pressMode === 'select') {
          // A fresh selection starts from the anchor note
          this._setSelection(this._selAnchor, this._selAnchor);
        }
      }
    }

    if (this._dragging) {
      if (this._pressMode === 'select') {
        var i = this._indexAtX(p.x);
        this._setSelection(Math.min(this._selAnchor, i), Math.max(this._selAnchor, i));
      } else {
        // Lift: only upward counts, saturating at liftRange
        var target = p.y - this._liftGrab - this._laneY();
        this._lift = Math.max(0, Math.min(this._liftRange, target));
      }
    }

    this._updateCursor(p);
  },

  onPointerUp(p, e) {
    if (!this._pressed) return;
    var wasDrag = this._dragging;
    var mode    = this._pressMode;
    this._pressed  = false;
    this._dragging = false;

    if (!wasDrag) {
      if (mode === 'band') {
        // Click on a note inside the selection toggles it in/out of the arp
        var i = this._indexAtX(p.x);
        if (i >= this._selStart && i <= this._selEnd
            && Math.abs(p.x - this._xForIndex(i)) <= this._spacing() * 0.5) {
          this._toggleNote(i);
        }
      } else {
        // Click off the band clears the selection
        this._setSelection(-1, -1);
      }
    } else if (mode === 'select') {
      this._saveState();
    }
    // Band drag release: the ramp in update() brings it home.
    this._updateCursor(p);
  },

  onPointerCancel(p, e) {
    this._pressed  = false;
    this._dragging = false;
    this._updateCursor(null);
  },

  _updateCursor(p) {
    if (this._dragging) {
      this._context.setCursor(this._pressMode === 'band' ? 'grabbing' : 'col-resize');
    } else if (p && this._onBand(p)) {
      this._context.setCursor('grab');
    } else {
      this._context.setCursor('');
    }
  },

  // ====================================================================
  // Mutations
  // ====================================================================

  _setSelection(start, end) {
    if (start === this._selStart && end === this._selEnd) return;
    var prevNote = this._currentNoteIdx();
    this._selStart = start;
    this._selEnd   = end;
    this._rebuildBand();
    if (prevNote >= 0 && start >= 0) {
      this._reconcileArp(prevNote);
    } else {
      this._restartFromBottom();
      this._sendSequence();
    }
    if (start < 0) this._saveState();
  },

  _toggleNote(i) {
    var prevNote = this._currentNoteIdx();
    if (this._disabled[i]) delete this._disabled[i];
    else                   this._disabled[i] = true;
    this._reconcileArp(prevNote >= 0 ? prevNote : i);
    this._saveState();
  },

  // ====================================================================
  // Frame update
  // ====================================================================

  update(delta, transport) {
    if (this._markers.length === 0) return;
    var dt  = Math.min(delta, 0.05);
    var dim = this._context.scene.userData.dimFactor ?? 1.0;
    var lifting = this._dragging && this._pressMode === 'band';

    // Ramp home when not held
    if (!lifting && this._lift > 0) {
      this._lift = Math.max(0, this._lift - (this._liftRange / this._rampSec) * dt);
      if (this._lift <= this._homeEps) this._lift = 0;
    }

    this._ratchet = Math.pow(this._maxRatchet, Math.max(0, Math.min(1, this._lift / this._liftRange)));

    var displaced = lifting || this._lift > this._homeEps;
    if (displaced) this._enterFree(transport);
    else           this._exitFree();

    if (this._free && transport.isPlaying) {
      var hz = this._baseHz(transport) * this._ratchet;
      this._freePhase += hz * dt;
      if (this._freePhase >= 1) {
        this._freePhase -= Math.floor(this._freePhase);
        this._freeHit(1000 / hz);
      }
    }
    this._flash = Math.max(0, this._flash - dt * 9);

    // --- Draw ---
    var laneY = this._laneY();
    var hasSel = this._hasSelection();

    for (var i = 0; i < this._markers.length; i++) {
      var m = this._markers[i];
      var inSel   = hasSel && i >= this._selStart && i <= this._selEnd;
      var dropped = inSel && !!this._disabled[i];
      var y = inSel ? laneY + this._lift : laneY;
      m.mesh.position.y  = y;
      m.label.position.y = y - 26;

      var base = dropped ? this._dropColor
               : inSel   ? this._selColor
               : m.isRoot ? this._rootColor : this._markerColor;
      this._tmpColor.copy(base);
      if (i === this._flashIdx && this._flash > 0) this._tmpColor.lerp(this._hitColor, this._flash);
      this._tmpColor.lerp(this._bgColor, (1 - dim) * 0.6);
      m.mesh.material.color.copy(this._tmpColor);

      var s = (inSel && !dropped ? 1.6 : 1) + (i === this._flashIdx ? this._flash * 1.2 : 0);
      m.mesh.scale.set(s, s, 1);
      m.label.material.opacity = (dropped ? 0.18 : inSel ? 0.9 : 0.4) * (0.4 + 0.6 * dim);
    }

    if (this._band) {
      this._band.position.y = laneY + this._lift;
      this._band.material.opacity = 0.07 + this._flash * 0.02;
    }

    var showLabel = hasSel && this._ratchet > 1.02;
    this._label.visible = showLabel;
    if (showLabel) {
      this._renderLabel('×' + this._ratchet.toFixed(1));
      var cx = (this._xForIndex(this._selStart) + this._xForIndex(this._selEnd)) / 2;
      this._label.position.set(cx, laneY + this._lift + this._bandHalfH + 16, 0.6);
    }
  },

  // ====================================================================
  // Shell lifecycle
  // ====================================================================

  pause() {
    this._pressed  = false;
    this._dragging = false;
  },

  // The arp starts from the bottom each time the experiment is shown; the lift
  // does not survive being hidden.
  resume() {
    this._free = false;
    this._lift = 0;
    this._restartFromBottom();
    this._sendSequence();
    this._saveState();
  },

  destroy() {
    if (this._unsubscribeScale) this._unsubscribeScale();
    this._clearScene();
    if (this._group && this._group.parent) this._group.parent.remove(this._group);
  },
};

Shell.register(ScaleFlickExperiment);
