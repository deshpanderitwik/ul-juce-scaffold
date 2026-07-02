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

  // --- Note grid (one row per octave, low at the bottom) ---
  _nodes: [],         // { mesh, labelSprite, midiNote, degree, octave, row, x, y, active, flash, targetColor, labelTargetColor }
  _nodeRadius: 18,
  _hoveredIndex: -1,

  _octaveStart: 1,     // bottom row — displayed octave (e.g. C1)
  _octaveEnd:   5,     // top row    — displayed octave (e.g. C5)
  _rowGap:       58,   // vertical distance between adjacent rows
  _sideMargin:   70,   // horizontal inset for each row
  _topBarHeight: 50,   // vertical space reserved for the shell's top bar

  _inactiveColor: 0x333333,
  _activeColor:   0xffffff,

  // --- Progression panel (one dot per chord) ---
  // Chords store node indices (degree + row), not MIDI notes, so a chord
  // keeps its shape when the key/scale changes.
  _chords: null,       // array of arrays of node indices
  _currentChord: 0,
  _panelObjects: [],   // everything the panel owns, for disposal
  _dots: [],           // { mesh, x, y, flash }
  _plus: null,         // { mesh, label, x, y }
  _deleteSprite: null,
  _deleteX: 0,
  _deleteY: 0,
  _hoveredDot: -1,

  _panelY:      50,    // distance from the bottom edge
  _dotRadius:   7,
  _dotSpacing:  30,
  _plusRadius:  10,
  _deleteOffsetY: 26,  // how far above a dot the delete affordance sits

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
    if (!data || !Array.isArray(data.chords)) return;

    // Drop malformed entries and node indices that don't fit the current
    // grid (e.g. the scale length changed since the state was saved).
    const chords = data.chords
      .filter(c => Array.isArray(c))
      .map(c => c.filter(idx =>
        typeof idx === 'number' && idx >= 0 && idx < this._nodes.length));
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
    this._hoveredIndex = -1;
    this._hoveredDot = -1;

    this._buildGrid();

    // Scale length may have changed — drop chord entries that point past
    // the new grid.
    for (let i = 0; i < this._chords.length; i++) {
      this._chords[i] = this._chords[i].filter(idx => idx < this._nodes.length);
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
    // panel (whose zone tops out at the delete affordance).
    const topEdge     = size.height - this._topBarHeight;
    const bottomEdge  = this._panelY + this._deleteOffsetY;
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

        this._nodes.push({
          mesh, labelSprite, midiNote, row, x, y,
          degree: d + 1,
          octave,
          active: false,
          flash: 0,
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
    this._hoveredDot = -1;

    const size = this._context.getSize();
    const n = this._chords.length;
    const plusGap = 40;

    const totalW = (n - 1) * this._dotSpacing + plusGap;
    const startX = size.width / 2 - totalW / 2;
    const y = this._panelY;

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

    // Delete affordance — hidden until a dot is hovered
    const del = this._makeLabel('×');
    del.material.color.setHex(0xcc6666);
    del.visible = false;
    this._group.add(del);
    this._panelObjects.push(del);
    this._deleteSprite = del;
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

  _updateDeleteAffordance() {
    if (!this._deleteSprite) return;
    // Deleting the last remaining chord isn't allowed, so don't offer it.
    const canDelete = this._hoveredDot !== -1 && this._chords.length > 1;
    this._deleteSprite.visible = canDelete;
    if (canDelete) {
      const dot = this._dots[this._hoveredDot];
      this._deleteX = dot.x;
      this._deleteY = dot.y + this._deleteOffsetY;
      this._deleteSprite.position.set(this._deleteX, this._deleteY, 0.3);
    }
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

  // Light up the current chord's notes on the grid (visual only — sound
  // comes from the sequencer, or from short auditions while editing).
  _applyCurrentChord() {
    const chord = this._chords[this._currentChord];
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      node.active = chord.indexOf(i) !== -1;
      node.targetColor.setHex(node.active ? this._activeColor : this._inactiveColor);
      node.labelTargetColor.setHex(node.active ? 0x111111 : 0xaaaaaa);
    }
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
      steps.push(this._chords[i].map(idx => this._nodes[idx].midiNote));
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
    this._onPointerDown = function (e) { self._handlePointerDown(e); };
    this._onPointerMove = function (e) { self._handlePointerMove(e); };
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
  },

  _unbindEvents() {
    const canvas = this._context.renderer.domElement;
    if (this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown);
    if (this._onPointerMove) canvas.removeEventListener('pointermove', this._onPointerMove);
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
      const dx = p.x - this._nodes[i].x;
      const dy = p.y - this._nodes[i].y;
      if (dx * dx + dy * dy <= r2) return i;
    }
    return -1;
  },

  // Returns { type: 'delete' | 'dot' | 'plus', index } or null
  _hitTestPanel(p) {
    if (this._deleteSprite && this._deleteSprite.visible) {
      const dx = p.x - this._deleteX;
      const dy = p.y - this._deleteY;
      if (dx * dx + dy * dy <= 12 * 12) {
        return { type: 'delete', index: this._hoveredDot };
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
      if (panelHit.type === 'delete')    this._deleteChord(panelHit.index);
      else if (panelHit.type === 'dot')  this._selectChord(panelHit.index);
      else if (panelHit.type === 'plus') this._addChord();
      this._updateDeleteAffordance();
      return;
    }

    const hit = this._hitTestNodes(p);
    if (hit === -1) return;

    const node  = this._nodes[hit];
    const chord = this._chords[this._currentChord];
    if (node.active) {
      node.active = false;
      node.targetColor.setHex(this._inactiveColor);
      node.labelTargetColor.setHex(0xaaaaaa);
      const pos = chord.indexOf(hit);
      if (pos !== -1) chord.splice(pos, 1);
    } else {
      node.active = true;
      node.targetColor.setHex(this._activeColor);
      node.labelTargetColor.setHex(0x111111);
      chord.push(hit);
    }
    this._sendSequence();
  },

  _handlePointerMove(e) {
    const p = this._pointerPos(e);

    const panelHit = this._hitTestPanel(p);
    this._hoveredDot = (panelHit && panelHit.type === 'dot') ? panelHit.index
                     : (panelHit && panelHit.type === 'delete') ? this._hoveredDot
                     : -1;
    this._updateDeleteAffordance();

    this._hoveredIndex = panelHit ? -1 : this._hitTestNodes(p);

    this._context.renderer.domElement.style.cursor =
      (panelHit || this._hoveredIndex !== -1) ? 'pointer' : '';
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
        const node = this._nodes[chord[i]];
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

      this._dimmedColor.copy(node.targetColor).lerp(this._bgColor, 1 - dim);
      node.mesh.material.color.lerp(this._dimmedColor, colorLerp);
      this._dimmedColor.copy(node.labelTargetColor).lerp(this._bgColor, 1 - dim);
      node.labelSprite.material.color.lerp(this._dimmedColor, colorLerp);
    }

    // Dots dim with the transport too (muted vs playing state), and the
    // selected/unselected color is derived here rather than set on click.
    for (let j = 0; j < this._dots.length; j++) {
      const dot = this._dots[j];
      dot.flash = Math.max(0, dot.flash - delta * 5);
      const ds = 1 + 0.5 * dot.flash;
      dot.mesh.scale.set(ds, ds, 1);

      this._dimmedColor
        .setHex(j === this._currentChord ? this._dotSelectedColor : this._dotColor)
        .lerp(this._bgColor, 1 - dim);
      dot.mesh.material.color.lerp(this._dimmedColor, colorLerp);
    }
  },

  pause() {
    this._unbindEvents();
    this._hoveredIndex = -1;
    this._hoveredDot = -1;
    this._updateDeleteAffordance();
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
