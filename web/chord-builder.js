// ==========================================================================
// Chord Builder
// ==========================================================================

const ChordBuilderExperiment = {
  id:          'chord-builder',
  name:        'Chord Builder',
  description: 'Build a chord progression, cycled by the step sequencer',
  showOctave:  false,   // grid spans a fixed octave range; the picker is moot

  // Chords change slowly — offer longer steps than the default set
  subdivisions: ['1bar', '1/2', '1/4', '1/8', '1/8T', '1/16'],

  _group: null,
  _context: null,
  _unsubscribeScale: null,
  _onPointerDown: null,
  _onPointerMove: null,
  _onPointerUp: null,
  _onPointerCancel: null,

  // --- Note grid (one row per octave, low at the bottom) ---
  _nodes: [],         // { mesh, labelSprite, ghost, midiNote, degree, octave, row, x, y, active, flash, phrasePx, targetColor, labelTargetColor }
  _nodeRadius: 18,
  _hoveredIndex: -1,

  // --- Phrasing (drag an active note rightward to delay it in its step) ---
  _maxPhrasePx:   36,   // drag range in px
  _maxDelay:      0.5,  // delay at full drag, as a fraction of one step
  _dragThreshold: 5,    // px of movement that turns a click into a drag
  _pressNode:     -1,   // node pressed but not yet classified click-vs-drag
  _pressPX:       0,
  _pressPY:       0,
  _draggingNote:  -1,
  _dragAnchorPx:  0,
  _dragStartX:    0,   // pointer x at drag ACTIVATION (not at press) — the
                       // threshold distance must not become a position jump

  _octaveStart: 1,     // bottom row — displayed octave (e.g. C1)
  _octaveEnd:   5,     // top row    — displayed octave (e.g. C5)
  _rowGap:       58,   // vertical distance between adjacent rows
  _sideMargin:   70,   // horizontal inset for each row
  _topBarHeight: 50,   // vertical space reserved for the shell's top bar

  _inactiveColor: 0x333333,
  _activeColor:   0xffffff,

  // --- Progression panel (one dot per chord) ---
  // Chords store node indices (degree + row), not MIDI notes, so a chord
  // keeps its shape when the key/scale changes. Each entry is
  // { idx, delay } — delay phrases the note later into the step, [0, _maxDelay].
  _chords: null,       // array of arrays of { idx, delay }
  _currentChord: 0,
  _stateRestored: false,  // gate saves until the stored progression is back
  _panelObjects: [],   // everything the panel owns, for disposal
  _dots: [],           // { mesh, x, y, flash }
  _plus: null,         // { mesh, label, x, y }
  _deleteSprite: null, // × — removes the chord (shown when >1 chord)
  _deleteBg: null,
  _deleteX: 0,
  _deleteY: 0,
  _clearSprite: null,  // − — empties the chord but keeps its slot
  _clearBg: null,
  _clearX: 0,
  _clearY: 0,
  _dupeSprite: null,   // ⧉ — inserts a copy of the chord right after it
  _dupeBg: null,
  _dupeX: 0,
  _dupeY: 0,
  _hoveredDot: -1,

  // Drag-to-reorder state for the chord dots
  _dotPress:     -1,   // dot pressed but not yet classified click-vs-drag
  _dotPressX:    0,
  _dotPressY:    0,
  _draggingDot:  -1,   // dot being dragged to a new position
  _dragDotX:     0,    // pointer-following x of the dragged dot
  _dragDotTarget: 0,   // insertion slot the drag currently points at
  _panelStartX:  0,    // x of slot 0, cached from the last panel rebuild

  _panelY:      50,    // distance from the bottom edge
  _dotRadius:   7,
  _dotSpacing:  30,
  _plusRadius:  10,
  _affordanceOffsetY: 34,  // how far above a dot the ×/− affordances sit
  _affordanceRadius:  10,  // circular background behind each glyph

  _dotColor:         0x555555,
  _dotSelectedColor: 0xffffff,

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._chords = [[]];
    this._currentChord = 0;

    this._unsubscribeScale = context.scale.onChange(() => {
      this._rebuild();
    });

    this._rebuild();
    this._bindEvents();

    // Restore the saved progression (persisted in the plugin, saved with
    // the DAW project). Arrives async; may fire immediately if cached.
    context.store.load((data) => this._restoreState(data));
  },

  _restoreState(data) {
    // From here on it's safe to persist — we're not at risk of clobbering
    // a stored progression with the boot-time empty one.
    this._stateRestored = true;

    if (!data || !Array.isArray(data.chords)) return;

    // Drop malformed entries and node indices that don't fit the current
    // grid (e.g. the scale length changed since the state was saved).
    // Migrates the older format where entries were bare node indices.
    const chords = data.chords
      .filter(c => Array.isArray(c))
      .map(c => c
        .map(e => {
          if (typeof e === 'number') return { idx: e, delay: 0 };
          if (e && typeof e.idx === 'number') {
            const d = typeof e.delay === 'number' ? e.delay : 0;
            return { idx: e.idx, delay: Math.max(0, Math.min(this._maxDelay, d)) };
          }
          return null;
        })
        .filter(e => e !== null && e.idx >= 0 && e.idx < this._nodes.length));
    if (chords.length === 0) chords.push([]);

    this._chords = chords;
    this._currentChord = Math.max(0, Math.min(
      typeof data.currentChord === 'number' ? data.currentChord : 0,
      chords.length - 1));

    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  _saveState() {
    if (!this._stateRestored) return;
    this._context.store.save({
      chords: this._chords,
      currentChord: this._currentChord
    });
  },

  _rebuild() {
    while (this._group.children.length) {
      const child = this._group.children[0];
      this._group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
    this._nodes = [];
    this._panelObjects = [];
    this._dots = [];
    this._plus = null;
    this._deleteSprite = null;
    this._deleteBg = null;
    this._clearSprite = null;
    this._clearBg = null;
    this._dupeSprite = null;
    this._dupeBg = null;
    this._hoveredIndex = -1;
    this._hoveredDot = -1;

    this._buildGrid();

    // Scale length may have changed — drop chord entries that point past
    // the new grid.
    for (let i = 0; i < this._chords.length; i++) {
      this._chords[i] = this._chords[i].filter(e => e.idx < this._nodes.length);
    }

    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  _buildGrid() {
    const ctx  = this._context;
    const size = ctx.getSize();

    const scaleLen = ctx.scale.getScaleLength();

    const usableW = size.width - this._sideMargin * 2;
    const stepX   = scaleLen > 1 ? usableW / (scaleLen - 1) : 0;

    const numRows = this._octaveEnd - this._octaveStart + 1;

    // Center the rows exactly between the top bar and the chord picker
    // panel (whose zone tops out at the hover affordances).
    const topEdge     = size.height - this._topBarHeight;
    const bottomEdge  = this._panelY + this._affordanceOffsetY;
    const rowsCenterY = (topEdge + bottomEdge) / 2;
    const rowsSpan    = (numRows - 1) * this._rowGap;

    for (let row = 0; row < numRows; row++) {
      // Bottom row = lowest octave, pitch reads upward.
      const y = rowsCenterY - rowsSpan / 2 + row * this._rowGap;
      // getNoteForDegree's octave param is one above the displayed octave
      // (scale.getBaseOctave() has the same +1 convention).
      const octave = this._octaveStart + row + 1;

      for (let d = 0; d < scaleLen; d++) {
        // Degree 1 on the left, ascending rightward
        const x = this._sideMargin + d * stepX;

        const midiNote = ctx.scale.getNoteForDegree(d + 1, octave);

        const geo  = new THREE.CircleGeometry(this._nodeRadius, 32);
        const mat  = new THREE.MeshBasicMaterial({ color: this._inactiveColor, transparent: true });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, 0.1);
        this._group.add(mesh);

        const labelSprite = this._makeLabel(ctx.scale.getNoteName(midiNote));
        labelSprite.position.set(x, y, 0.2);
        this._group.add(labelSprite);

        // Ghost outline marking the home slot while the note is phrased
        const ghost = this._makeCircleOutline(this._nodeRadius);
        ghost.position.set(x, y, 0.05);
        ghost.visible = false;
        this._group.add(ghost);

        this._nodes.push({
          mesh, labelSprite, ghost, midiNote, row, x, y,
          degree: d + 1,
          octave,
          active: false,
          flash: 0,
          phrasePx: 0,
          dispPhrasePx: 0,   // eased toward phrasePx for smooth motion
          targetColor:      new THREE.Color(this._inactiveColor),
          labelTargetColor: new THREE.Color(0xaaaaaa)
        });
      }
    }
  },

  // ==================================================================
  // Progression panel
  // ==================================================================

  _rebuildPanel() {
    for (let i = 0; i < this._panelObjects.length; i++) {
      const obj = this._panelObjects[i];
      this._group.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    }
    this._panelObjects = [];
    this._dots = [];
    this._plus = null;
    this._deleteSprite = null;
    this._deleteBg = null;
    this._clearSprite = null;
    this._clearBg = null;
    this._dupeSprite = null;
    this._dupeBg = null;
    this._hoveredDot = -1;

    const size = this._context.getSize();
    const n = this._chords.length;
    const plusGap = 40;

    const totalW = (n - 1) * this._dotSpacing + plusGap;
    const startX = size.width / 2 - totalW / 2;
    const y = this._panelY;
    this._panelStartX = startX;

    // Backdrop pill, styled to match the shell's top bar
    // (rgba(0,0,0,0.4), fully rounded ends)
    const bgH    = 36;
    const bgGeo  = this._makeRoundedRectGeometry(totalW + 56, bgH, bgH / 2);
    const bgMat  = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
    const bgMesh = new THREE.Mesh(bgGeo, bgMat);
    bgMesh.position.set(size.width / 2, y, 0.05);
    this._group.add(bgMesh);
    this._panelObjects.push(bgMesh);

    for (let i = 0; i < n; i++) {
      const x = startX + i * this._dotSpacing;
      const geo  = new THREE.CircleGeometry(this._dotRadius, 24);
      const mat  = new THREE.MeshBasicMaterial({
        color: i === this._currentChord ? this._dotSelectedColor : this._dotColor
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, 0.1);
      this._group.add(mesh);
      this._panelObjects.push(mesh);
      this._dots.push({ mesh, x, y, flash: 0 });
    }

    // Plus button
    const plusX = startX + (n - 1) * this._dotSpacing + plusGap;
    const plusGeo  = new THREE.CircleGeometry(this._plusRadius, 24);
    const plusMat  = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
    const plusMesh = new THREE.Mesh(plusGeo, plusMat);
    plusMesh.position.set(plusX, y, 0.1);
    this._group.add(plusMesh);
    this._panelObjects.push(plusMesh);

    const plusLabel = this._makeLabel('+');
    plusLabel.material.color.setHex(0x888888);
    plusLabel.position.set(plusX, y + 0.5, 0.2);
    this._group.add(plusLabel);
    this._panelObjects.push(plusLabel);

    this._plus = { mesh: plusMesh, label: plusLabel, x: plusX, y };

    // Hover affordances — hidden until a dot is hovered.
    // × deletes the chord; − clears its notes but keeps the slot.
    // Each glyph sits on a circular background, like the plus button.
    const makeAffordanceBg = () => {
      const geo  = new THREE.CircleGeometry(this._affordanceRadius, 24);
      const mat  = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this._group.add(mesh);
      this._panelObjects.push(mesh);
      return mesh;
    };

    this._deleteBg = makeAffordanceBg();
    const del = this._makeLabel('×');
    del.material.color.setHex(0xcc6666);
    del.visible = false;
    this._group.add(del);
    this._panelObjects.push(del);
    this._deleteSprite = del;

    this._clearBg = makeAffordanceBg();
    const clr = this._makeLabel('−');
    clr.material.color.setHex(0x999999);
    clr.visible = false;
    this._group.add(clr);
    this._panelObjects.push(clr);
    this._clearSprite = clr;

    this._dupeBg = makeAffordanceBg();
    const dup = this._makeLabel('⧉');
    dup.material.color.setHex(0x999999);
    dup.visible = false;
    this._group.add(dup);
    this._panelObjects.push(dup);
    this._dupeSprite = dup;
  },

  _makeCircleOutline(radius) {
    const segments = 40;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.85 });
    return new THREE.LineLoop(geo, mat);
  },

  _makeRoundedRectGeometry(w, h, r) {
    const shape = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return new THREE.ShapeGeometry(shape);
  },

  _updateDotAffordances() {
    if (!this._deleteSprite || !this._clearSprite) return;

    const hovering = this._hoveredDot !== -1;
    // Deleting the last remaining chord isn't allowed, so don't offer it.
    const canDelete = hovering && this._chords.length > 1;

    this._deleteSprite.visible = canDelete;
    this._deleteBg.visible     = canDelete;
    this._clearSprite.visible  = hovering;
    this._clearBg.visible      = hovering;
    this._dupeSprite.visible   = hovering;
    this._dupeBg.visible       = hovering;
    if (!hovering) return;

    const dot = this._dots[this._hoveredDot];
    const y   = dot.y + this._affordanceOffsetY;

    if (canDelete) {
      // Three across: × | − | ⧉
      this._deleteX = dot.x - 24;
      this._deleteY = y;
      this._deleteSprite.position.set(this._deleteX, this._deleteY, 0.3);
      this._deleteBg.position.set(this._deleteX, this._deleteY, 0.25);
      this._clearX = dot.x;
      this._clearY = y;
      this._dupeX  = dot.x + 24;
      this._dupeY  = y;
    } else {
      // No × (last remaining chord) — just − | ⧉
      this._clearX = dot.x - 12;
      this._clearY = y;
      this._dupeX  = dot.x + 12;
      this._dupeY  = y;
    }
    this._clearSprite.position.set(this._clearX, this._clearY, 0.3);
    this._clearBg.position.set(this._clearX, this._clearY, 0.25);
    this._dupeSprite.position.set(this._dupeX, this._dupeY, 0.3);
    this._dupeBg.position.set(this._dupeX, this._dupeY, 0.25);
  },

  // While the affordances are showing, the pointer is allowed to travel
  // from the dot up to them without losing the hover — this capsule covers
  // the dot, both glyphs, and the corridor between. Without it, the pixel
  // gap between the dot's hit circle and the glyphs' hit circles would
  // hide the affordances mid-journey (and a hidden glyph can't be hit).
  _inAffordanceCorridor(p) {
    const dot = this._dots[this._hoveredDot];
    if (!dot) return false;
    return p.x >= dot.x - 36 && p.x <= dot.x + 36 &&
           p.y >= dot.y - 14 && p.y <= dot.y + this._affordanceOffsetY + 12;
  },

  _selectChord(index) {
    if (index === this._currentChord) return;
    this._currentChord = index;
    // Dot colors follow _currentChord in update()
    this._applyCurrentChord();
    this._saveState();
  },

  _addChord() {
    this._chords.push([]);
    this._currentChord = this._chords.length - 1;
    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  _deleteChord(index) {
    if (this._chords.length <= 1) return;
    this._chords.splice(index, 1);

    if (index < this._currentChord || this._currentChord >= this._chords.length) {
      this._currentChord--;
    }
    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  // Move a chord from one slot to another, keeping the same chord selected.
  _commitReorder(from, to) {
    if (to === from || !this._chords[from]) {
      this._rebuildPanel();   // snap the dragged dot back to its slot
      return;
    }

    const moved = this._chords.splice(from, 1)[0];
    this._chords.splice(to, 0, moved);

    let cur = this._currentChord;
    if (cur === from) {
      cur = to;
    } else {
      if (from < cur) cur--;   // removal shifted it down...
      if (to <= cur) cur++;    // ...insertion may shift it back up
    }
    this._currentChord = cur;

    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  // Insert a copy of a chord (notes + phrasing) right after it, and select
  // the copy — ready to be varied.
  _duplicateChord(index) {
    const src = this._chords[index];
    if (!src) return;
    const copy = src.map(e => ({ idx: e.idx, delay: e.delay }));
    this._chords.splice(index + 1, 0, copy);
    this._currentChord = index + 1;
    this._rebuildPanel();
    this._applyCurrentChord();
    this._sendSequence();
  },

  // Empty a chord's notes but keep its slot in the progression.
  _clearChordNotes(index) {
    const chord = this._chords[index];
    if (!chord || chord.length === 0) return;
    this._chords[index] = [];
    if (index === this._currentChord) this._applyCurrentChord();
    this._sendSequence();
  },

  // Light up the current chord's notes on the grid (visual only — sound
  // comes from the sequencer while the transport plays). Also positions
  // each member at its phrasing offset.
  _applyCurrentChord() {
    const chord = this._chords[this._currentChord];
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      const entry = chord.find(en => en.idx === i);
      node.active = !!entry;
      node.phrasePx = entry ? (entry.delay / this._maxDelay) * this._maxPhrasePx : 0;
      node.targetColor.setHex(node.active ? this._activeColor : this._inactiveColor);
      node.labelTargetColor.setHex(node.active ? 0x111111 : 0xaaaaaa);
    }
  },

  // Toggle a note in/out of the current chord (a clean click, not a drag)
  _toggleNode(index) {
    const node  = this._nodes[index];
    const chord = this._chords[this._currentChord];
    const pos = chord.findIndex(en => en.idx === index);

    if (pos !== -1) {
      chord.splice(pos, 1);
      node.active = false;
      node.phrasePx = 0;
      node.targetColor.setHex(this._inactiveColor);
      node.labelTargetColor.setHex(0xaaaaaa);
    } else {
      chord.push({ idx: index, delay: 0 });
      node.active = true;
      node.phrasePx = 0;
      node.targetColor.setHex(this._activeColor);
      node.labelTargetColor.setHex(0x111111);
    }
    this._sendSequence();
  },

  // Push the whole progression to the C++ sequencer: one step per chord,
  // each step an array of MIDI notes (empty chord = silent step). The gate
  // is deliberately huge so the C++ side clamps it to one full step — every
  // subdivision boundary re-strikes the full chord (a lone chord repeats
  // every step). Editing makes no sound; the progression only sounds while
  // the host transport plays.
  _sendSequence() {
    const steps = [];
    for (let i = 0; i < this._chords.length; i++) {
      steps.push(this._chords[i].map(e => {
        const midiNote = this._nodes[e.idx].midiNote;
        // Phrased notes ride along as { n, d }; plain notes stay bare ints
        return e.delay > 0 ? { n: midiNote, d: e.delay } : midiNote;
      }));
    }
    this._context.midi.setStepSequence(steps, 60000, false);
    this._saveState();
  },

  _makeLabel(text) {
    const c  = document.createElement('canvas');
    const cx = c.getContext('2d');
    c.width  = 96;
    c.height = 32;
    cx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = '#ffffff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, color: 0xaaaaaa });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(64, 22, 1);
    return spr;
  },

  // ==================================================================
  // Input
  // ==================================================================

  _bindEvents() {
    const self = this;
    const canvas = this._context.renderer.domElement;
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
    const canvas = this._context.renderer.domElement;
    if (this._onPointerDown)   canvas.removeEventListener('pointerdown',   this._onPointerDown);
    if (this._onPointerMove)   canvas.removeEventListener('pointermove',   this._onPointerMove);
    if (this._onPointerUp)     canvas.removeEventListener('pointerup',     this._onPointerUp);
    if (this._onPointerCancel) canvas.removeEventListener('pointercancel', this._onPointerCancel);
  },

  _pointerPos(e) {
    const rect = this._context.renderer.domElement.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: rect.height - (e.clientY - rect.top)
    };
  },

  _hitTestNodes(p) {
    const r2 = this._nodeRadius * this._nodeRadius;
    for (let i = 0; i < this._nodes.length; i++) {
      // Hit-test where the node is drawn (including its phrasing offset)
      const dx = p.x - (this._nodes[i].x + this._nodes[i].phrasePx);
      const dy = p.y - this._nodes[i].y;
      if (dx * dx + dy * dy <= r2) return i;
    }
    return -1;
  },

  // Returns { type: 'delete' | 'clear' | 'dot' | 'plus', index } or null
  _hitTestPanel(p) {
    if (this._deleteSprite && this._deleteSprite.visible) {
      const dx = p.x - this._deleteX;
      const dy = p.y - this._deleteY;
      if (dx * dx + dy * dy <= 11 * 11) {
        return { type: 'delete', index: this._hoveredDot };
      }
    }
    if (this._clearSprite && this._clearSprite.visible) {
      const dx = p.x - this._clearX;
      const dy = p.y - this._clearY;
      if (dx * dx + dy * dy <= 11 * 11) {
        return { type: 'clear', index: this._hoveredDot };
      }
    }
    if (this._dupeSprite && this._dupeSprite.visible) {
      const dx = p.x - this._dupeX;
      const dy = p.y - this._dupeY;
      if (dx * dx + dy * dy <= 11 * 11) {
        return { type: 'dupe', index: this._hoveredDot };
      }
    }
    // Generous hit zone around the small dots
    const dotHit2 = 12 * 12;
    for (let i = 0; i < this._dots.length; i++) {
      const dx = p.x - this._dots[i].x;
      const dy = p.y - this._dots[i].y;
      if (dx * dx + dy * dy <= dotHit2) return { type: 'dot', index: i };
    }
    if (this._plus) {
      const dx = p.x - this._plus.x;
      const dy = p.y - this._plus.y;
      if (dx * dx + dy * dy <= this._plusRadius * this._plusRadius * 2) {
        return { type: 'plus', index: -1 };
      }
    }
    return null;
  },

  _handlePointerDown(e) {
    if (e.button !== 0) return;
    const p = this._pointerPos(e);

    const panelHit = this._hitTestPanel(p);
    if (panelHit) {
      if (panelHit.type === 'dot') {
        // Click = select, drag = reorder. Decided by the movement
        // threshold (pointermove) / the release (pointerup).
        this._dotPress = panelHit.index;
        this._dotPressX = p.x;
        this._dotPressY = p.y;
        this._draggingDot = -1;
        try { this._context.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
        return;
      }
      if (panelHit.type === 'delete')     this._deleteChord(panelHit.index);
      else if (panelHit.type === 'clear') this._clearChordNotes(panelHit.index);
      else if (panelHit.type === 'dupe')  this._duplicateChord(panelHit.index);
      else if (panelHit.type === 'plus')  this._addChord();
      this._updateDotAffordances();
      return;
    }

    const hit = this._hitTestNodes(p);
    if (hit === -1) return;

    // Click = toggle, drag right = phrase. Which one is decided by the
    // movement threshold in pointermove / the release in pointerup.
    this._pressNode = hit;
    this._pressPX = p.x;
    this._pressPY = p.y;
    this._draggingNote = -1;
    try { this._context.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
  },

  _handlePointerUp(e) {
    if (e.button !== 0) return;
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}

    if (this._dotPress !== -1) {
      const pressed  = this._dotPress;
      const dragging = this._draggingDot;
      const target   = this._dragDotTarget;
      this._dotPress = -1;
      this._draggingDot = -1;

      if (dragging !== -1) {
        this._commitReorder(dragging, target);
      } else {
        this._selectChord(pressed);
        this._updateDotAffordances();
      }
      return;
    }

    if (this._pressNode === -1) return;

    const pressed     = this._pressNode;
    const wasDragging = this._draggingNote !== -1;
    this._pressNode    = -1;
    this._draggingNote = -1;

    if (wasDragging) {
      // Commit the new phrasing to the sequencer (and persistence)
      this._sendSequence();
      return;
    }

    const p = this._pointerPos(e);
    const dx = p.x - this._pressPX;
    const dy = p.y - this._pressPY;
    const t = this._dragThreshold;
    if (dx * dx + dy * dy <= t * t) this._toggleNode(pressed);
  },

  _handlePointerCancel(e) {
    this._pressNode = -1;
    this._draggingNote = -1;
    this._dotPress = -1;
    this._draggingDot = -1;
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}
  },

  _handlePointerMove(e) {
    const p = this._pointerPos(e);

    // Enter a dot-reorder drag: pressed on a chord dot + moved past the
    // threshold. The affordances hide for the duration.
    if (this._dotPress !== -1 && this._draggingDot === -1) {
      const dx = p.x - this._dotPressX;
      const dy = p.y - this._dotPressY;
      const t = this._dragThreshold;
      if (dx * dx + dy * dy > t * t) {
        this._draggingDot = this._dotPress;
        this._dragDotTarget = this._dotPress;
        this._hoveredDot = -1;
        this._updateDotAffordances();
      }
    }

    if (this._draggingDot !== -1) {
      const n = this._dots.length;
      const spanEnd = this._panelStartX + (n - 1) * this._dotSpacing;
      this._dragDotX = Math.max(this._panelStartX - 20, Math.min(spanEnd + 20, p.x));
      this._dragDotTarget = Math.max(0, Math.min(n - 1,
        Math.round((this._dragDotX - this._panelStartX) / this._dotSpacing)));
      this._context.renderer.domElement.style.cursor = 'grabbing';
      return;
    }

    // Enter a phrasing drag: pressed on an active note + moved past the
    // threshold. Inactive notes can't be phrased — a press on one stays a
    // (potential) click.
    if (this._pressNode !== -1 && this._draggingNote === -1) {
      const pressNode = this._nodes[this._pressNode];
      const dx = p.x - this._pressPX;
      const dy = p.y - this._pressPY;
      const t = this._dragThreshold;
      if (pressNode && pressNode.active && dx * dx + dy * dy > t * t) {
        this._draggingNote = this._pressNode;
        this._dragAnchorPx = pressNode.phrasePx;
        this._dragStartX   = p.x;
      }
    }

    if (this._draggingNote !== -1) {
      const node  = this._nodes[this._draggingNote];
      const chord = this._chords[this._currentChord];
      const entry = chord.find(en => en.idx === this._draggingNote);
      node.phrasePx = Math.max(0, Math.min(this._maxPhrasePx,
        this._dragAnchorPx + (p.x - this._dragStartX)));
      if (entry) entry.delay = (node.phrasePx / this._maxPhrasePx) * this._maxDelay;
      this._context.renderer.domElement.style.cursor = 'grabbing';
      return;
    }

    const panelHit = this._hitTestPanel(p);
    if (panelHit && panelHit.type === 'dot') {
      this._hoveredDot = panelHit.index;
    } else if (panelHit && (panelHit.type === 'delete' || panelHit.type === 'clear' || panelHit.type === 'dupe')) {
      // On a glyph — keep the current dot's affordances up
    } else if (this._hoveredDot !== -1 && this._inAffordanceCorridor(p)) {
      // Traveling between the dot and its glyphs — keep them up
    } else {
      this._hoveredDot = -1;
    }
    this._updateDotAffordances();

    this._hoveredIndex = panelHit ? -1 : this._hitTestNodes(p);

    let cursor = '';
    if (panelHit) {
      cursor = panelHit.type === 'dot' ? 'grab' : 'pointer';
    } else if (this._hoveredIndex !== -1) {
      // Active notes are draggable (phrasing); inactive ones just toggle
      cursor = this._nodes[this._hoveredIndex].active ? 'grab' : 'pointer';
    }
    this._context.renderer.domElement.style.cursor = cursor;
  },

  // ==================================================================
  // Lifecycle
  // ==================================================================

  // Quantized hook — the shell calls this at every subdivision boundary
  // while the transport plays (and shows the subdivision selector because
  // this method exists). The C++ sequencer makes the sound; this is the
  // visual echo.
  step(stepIndex) {
    const n = this._chords.length;
    if (n === 0) return;
    const playing = ((stepIndex % n) + n) % n;

    const dot = this._dots[playing];
    if (dot) dot.flash = 1;

    // If the playing chord is the one on the grid, pulse its notes too
    if (playing === this._currentChord) {
      const chord = this._chords[playing];
      for (let i = 0; i < chord.length; i++) {
        const node = this._nodes[chord[i].idx];
        if (node) node.flash = 1;
      }
    }
  },

  _bgColor: new THREE.Color(0x111111),
  _dimmedColor: new THREE.Color(),

  update(delta, transport) {
    const colorLerp = Math.min(1, delta * 20);
    const dim = this._context.scene.userData.dimFactor ?? 1.0;

    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];

      node.flash = Math.max(0, node.flash - delta * 5);
      const s = 1 + 0.12 * node.flash;
      node.mesh.scale.set(s, s, 1);
      node.labelSprite.scale.set(64 * s, 22 * s, 1);

      // Phrasing offset: the circle (and label) sit right of the home slot;
      // a ghost outline marks the slot while the note is displaced. The
      // displayed offset eases toward the logical one — fast enough to feel
      // 1:1 under the pointer, but it swallows discontinuities (drag entry,
      // toggle resets, chord switches) instead of visibly stepping.
      node.dispPhrasePx += (node.phrasePx - node.dispPhrasePx) * Math.min(1, delta * 30);
      if (Math.abs(node.phrasePx - node.dispPhrasePx) < 0.1) {
        node.dispPhrasePx = node.phrasePx;
      }
      const dispX = node.x + node.dispPhrasePx;
      node.mesh.position.x = dispX;
      node.labelSprite.position.x = dispX;
      node.ghost.visible = node.active && node.dispPhrasePx > 2;

      this._dimmedColor.copy(node.targetColor).lerp(this._bgColor, 1 - dim);
      node.mesh.material.color.lerp(this._dimmedColor, colorLerp);
      this._dimmedColor.copy(node.labelTargetColor).lerp(this._bgColor, 1 - dim);
      node.labelSprite.material.color.lerp(this._dimmedColor, colorLerp);
    }

    // Dots dim with the transport too (muted vs playing state), and the
    // selected/unselected color is derived here rather than set on click.
    // During a reorder drag the dragged dot follows the pointer and the
    // others slide aside to open the insertion slot.
    let reorderSlot = 0;
    for (let j = 0; j < this._dots.length; j++) {
      const dot = this._dots[j];
      dot.flash = Math.max(0, dot.flash - delta * 5);
      const ds = 1 + 0.5 * dot.flash;
      dot.mesh.scale.set(ds, ds, 1);

      this._dimmedColor
        .setHex(j === this._currentChord ? this._dotSelectedColor : this._dotColor)
        .lerp(this._bgColor, 1 - dim);
      dot.mesh.material.color.lerp(this._dimmedColor, colorLerp);

      if (this._draggingDot === j) {
        dot.mesh.position.x = this._dragDotX;
        dot.mesh.position.y = dot.y + 4;   // slight lift while in hand
        continue;
      }
      let targetX = dot.x;
      if (this._draggingDot !== -1) {
        if (reorderSlot === this._dragDotTarget) reorderSlot++;  // hole for the dragged dot
        targetX = this._panelStartX + reorderSlot * this._dotSpacing;
        reorderSlot++;
      }
      dot.mesh.position.x += (targetX - dot.mesh.position.x) * Math.min(1, delta * 15);
      dot.mesh.position.y = dot.y;
    }
  },

  pause() {
    this._unbindEvents();
    // Mid-drag phrasing has been mutating the chord entry live — keep it,
    // but make sure it reaches the sequencer/persistence like a normal
    // drag release would.
    if (this._draggingNote !== -1) this._sendSequence();
    this._pressNode = -1;
    this._draggingNote = -1;
    this._dotPress = -1;
    this._draggingDot = -1;
    this._hoveredIndex = -1;
    this._hoveredDot = -1;
    this._updateDotAffordances();
    this._context.renderer.domElement.style.cursor = '';
    // Silence the shared C++ sequencer while inactive; resume() resends.
    this._context.midi.setStepSequence([], 150);
  },

  resume() {
    this._bindEvents();
    this._sendSequence();
  },

  destroy() {
    this._unbindEvents();
    if (this._unsubscribeScale) this._unsubscribeScale();
    this._context.midi.setStepSequence([], 150);
  },
};

Shell.register(ChordBuilderExperiment);
