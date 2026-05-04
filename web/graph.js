Shell.register({
  id:          'graph',
  name:        'Graph',
  description: 'Build a chain across two rings of scale-degree nodes',

  _group: null,
  _context: null,
  _unsubscribeScale: null,
  _onClick: null,
  _onDblClick: null,
  _onMouseMove: null,
  _hoveredIndex: -1,

  _nodes: [],         // { mesh, labelSprite, midiNote, degree, octave, ring, angle, x, y, active, flashTimer }
  _edges: [],         // { line, fromIndex, toIndex }
  _sequence: [],      // ordered node indices (activation order)
  _cursor: 0,         // current position in the sequence

  _innerRadius: 0,
  _outerRadius: 0,
  _nodeRadius:  20,
  _nodeRadiusInner: 26,

  _inactiveColor: 0x333333,
  _activeColor:   0xffffff,
  _headRing:      null,

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._unsubscribeScale = context.scale.onChange(() => {
      this._rebuildNotes();
    });

    this._buildNodes();
    this._buildHeadRing();
    this._chainRestored = false;
    this._bindEvents();
  },

  _buildHeadRing() {
    var segments = 64;
    var points = [];
    for (var i = 0; i <= segments; i++) {
      var theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    this._headRing = new THREE.LineLoop(geo, mat);
    this._headRing.visible = false;
    this._headRing.position.z = 0.15;
    this._group.add(this._headRing);
  },

  _updateHeadRing() {
    if (this._sequence.length === 0) {
      this._headRing.visible = false;
      return;
    }
    var headIndex = this._sequence[this._sequence.length - 1];
    var node = this._nodes[headIndex];
    var ringSize = (node.ring === 0 ? this._nodeRadiusInner : this._nodeRadius) + 6;
    this._headRing.scale.set(ringSize, ringSize, 1);
    this._headRing.position.x = node.x;
    this._headRing.position.y = node.y;
    this._headRing.visible = true;
  },

  // ==================================================================
  // Event handling
  // ==================================================================

  _bindEvents() {
    var self = this;
    var canvas = this._context.renderer.domElement;

    this._onClick = function (e) { self._handleClick(e); };
    this._onDblClick = function (e) { self._handleDblClick(e); };
    this._onMouseMove = function (e) { self._handleMouseMove(e); };

    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('dblclick', this._onDblClick);
    canvas.addEventListener('mousemove', this._onMouseMove);
  },

  _unbindEvents() {
    var canvas = this._context.renderer.domElement;
    if (this._onClick) canvas.removeEventListener('click', this._onClick);
    if (this._onDblClick) canvas.removeEventListener('dblclick', this._onDblClick);
    if (this._onMouseMove) canvas.removeEventListener('mousemove', this._onMouseMove);
  },

  _hitTest(e) {
    var rect = this._context.renderer.domElement.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = rect.height - (e.clientY - rect.top);

    for (var i = 0; i < this._nodes.length; i++) {
      var node = this._nodes[i];
      var hitRadius = node.ring === 0 ? this._nodeRadiusInner : this._nodeRadius;
      var dx = mx - node.x;
      var dy = my - node.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        return i;
      }
    }
    return -1;
  },

  _handleClick(e) {
    var hit = this._hitTest(e);
    if (hit === -1) return;

    var node = this._nodes[hit];
    var head = this._sequence.length > 0 ? this._sequence[this._sequence.length - 1] : -1;

    if (this._sequence.length === 0 && !node.active) {
      // First activation — no chain yet, click any inactive node
      this._activateNode(hit);
    } else if (hit === head) {
      // Clicked the head — retract
      this._retractHead();
    } else if (!node.active && head !== -1) {
      // Clicked an inactive node while a head exists — extend
      this._extendChain(hit);
    }
  },

  _handleMouseMove(e) {
    var hit = this._hitTest(e);

    // Non-head active nodes are not interactive
    if (hit !== -1) {
      var node = this._nodes[hit];
      var head = this._sequence.length > 0 ? this._sequence[this._sequence.length - 1] : -1;
      if (node.active && hit !== head) {
        hit = -1;
      }
    }

    if (hit !== this._hoveredIndex) {
      this._hoveredIndex = hit;
      var canvas = this._context.renderer.domElement;
      canvas.style.cursor = hit !== -1 ? 'pointer' : '';
    }
  },

  _handleDblClick(e) {
    var hit = this._hitTest(e);
    if (hit !== -1) return;
    this._clearChain();
  },

  // ==================================================================
  // Chain operations
  // ==================================================================

  _popNode(index) {
    var node = this._nodes[index];
    node.springVelocity = 2.0;
  },

  _activateNode(index) {
    var node = this._nodes[index];
    node.active = true;
    node.targetColor.setHex(this._activeColor);
    node.labelTargetColor.setHex(0x111111);
    this._sequence.push(index);
    this._popNode(index);
    this._updateHeadRing();
    this._sendSequence();
  },

  _extendChain(index) {
    var headIndex = this._sequence[this._sequence.length - 1];

    this._addEdge(headIndex, index);
    this._activateNode(index);
  },

  _retractHead() {
    if (this._sequence.length === 0) return;

    var headIndex = this._sequence.pop();
    var headNode = this._nodes[headIndex];
    headNode.active = false;
    headNode.targetColor.setHex(this._inactiveColor);
    headNode.labelTargetColor.setHex(0xaaaaaa);
    this._popNode(headIndex);

    if (this._edges.length > 0) {
      var edge = this._edges.pop();
      this._group.remove(edge.line);
    }

    if (this._sequence.length > 0) {
      var newHeadIndex = this._sequence[this._sequence.length - 1];
      this._popNode(newHeadIndex);
    }

    this._updateHeadRing();
    this._sendSequence();
  },

  _clearChain() {
    for (var i = 0; i < this._nodes.length; i++) {
      this._nodes[i].active = false;
      this._nodes[i].targetColor.setHex(this._inactiveColor);
      this._nodes[i].labelTargetColor.setHex(0xaaaaaa);
      this._nodes[i].flashTimer = 0;
    }
    for (var j = 0; j < this._edges.length; j++) {
      this._group.remove(this._edges[j].line);
    }
    this._edges = [];
    this._sequence = [];
    this._cursor = 0;
    this._updateHeadRing();
    this._sendSequence();
  },

  _addEdge(fromIndex, toIndex) {
    var a = this._nodes[fromIndex];
    var b = this._nodes[toIndex];
    var points = [
      new THREE.Vector3(a.x, a.y, 0.05),
      new THREE.Vector3(b.x, b.y, 0.05)
    ];
    var geo = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true });
    var line = new THREE.Line(geo, mat);
    this._group.add(line);
    this._edges.push({ line: line, fromIndex: fromIndex, toIndex: toIndex });
  },

  // ==================================================================
  // Build / Rebuild
  // ==================================================================

  _buildNodes() {
    var ctx  = this._context;
    var size = ctx.getSize();
    var cx   = size.width / 2;
    var cy   = size.height / 2;

    var maxDim = Math.min(size.width, size.height);
    this._outerRadius = maxDim * 0.36;
    this._innerRadius = maxDim * 0.22;

    var scaleLen = ctx.scale.getScaleLength();
    var numPerRing = scaleLen;

    this._nodes = [];

    for (var ring = 0; ring < 2; ring++) {
      var radius    = ring === 0 ? this._innerRadius : this._outerRadius;
      var nodeSize  = ring === 0 ? this._nodeRadiusInner : this._nodeRadius;
      var baseOct   = ctx.scale.getBaseOctave();
      var octave    = ring === 0 ? baseOct : baseOct + 1;

      for (var d = 0; d < numPerRing; d++) {
        var angle = -Math.PI / 2 + (d / numPerRing) * Math.PI * 2;
        var x = cx + Math.cos(angle) * radius;
        var y = cy + Math.sin(angle) * radius;

        var midiNote = ctx.scale.getNoteForDegree(d + 1, octave);

        var geo  = new THREE.CircleGeometry(nodeSize, 32);
        var mat  = new THREE.MeshBasicMaterial({ color: this._inactiveColor, transparent: true });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, 0.1);
        this._group.add(mesh);

        var labelSprite = this._makeLabel(ctx.scale.getNoteName(midiNote));
        labelSprite.position.set(x, y, 0.2);
        this._group.add(labelSprite);

        this._nodes.push({
          mesh: mesh,
          labelSprite: labelSprite,
          midiNote: midiNote,
          degree: d + 1,
          octave: octave,
          ring: ring,
          angle: angle,
          x: x,
          y: y,
          active: false,
          flashTimer: 0,
          targetColor: new THREE.Color(this._inactiveColor),
          labelTargetColor: new THREE.Color(0xaaaaaa),
          springScale: 1.0,
          springVelocity: 0.0
        });
      }
    }
  },

  _rebuildNotes() {
    var ctx = this._context;
    var scaleLen = ctx.scale.getScaleLength();

    for (var i = 0; i < this._nodes.length; i++) {
      var node = this._nodes[i];
      var degree = ((i % scaleLen) + 1);
      var baseOct = ctx.scale.getBaseOctave();
      var octave = i < scaleLen ? baseOct : baseOct + 1;
      node.midiNote = ctx.scale.getNoteForDegree(degree, octave);
      node.degree = degree;
      node.octave = octave;

      this._group.remove(node.labelSprite);
      if (node.labelSprite.material.map) node.labelSprite.material.map.dispose();
      node.labelSprite.material.dispose();

      node.labelSprite = this._makeLabel(ctx.scale.getNoteName(node.midiNote));
      node.labelSprite.position.set(node.x, node.y, 0.2);
      this._group.add(node.labelSprite);
    }

    this._sendSequence();
  },

  _makeLabel(text) {
    var c  = document.createElement('canvas');
    var cx = c.getContext('2d');
    c.width  = 96;
    c.height = 32;
    cx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = '#ffffff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, c.width / 2, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, color: 0xaaaaaa });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(64, 22, 1);
    return spr;
  },

  _rebuild() {
    while (this._group.children.length) {
      this._group.remove(this._group.children[0]);
    }
    this._nodes = [];
    this._edges = [];
    this._sequence = [];
    this._buildNodes();
    this._buildHeadRing();
  },

  // ==================================================================
  // Lifecycle
  // ==================================================================

  _sendSequence() {
    var notes = [];
    for (var i = 0; i < this._sequence.length; i++) {
      notes.push(this._nodes[this._sequence[i]].midiNote);
    }
    this._context.midi.setStepSequence(notes, 150);
    this._saveChain();
  },

  _getSessionId() {
    return this._context.getTransport().sessionId || '';
  },

  _saveChain() {
    localStorage.setItem('graph.chain', JSON.stringify(this._sequence));
    localStorage.setItem('graph.sessionId', this._getSessionId());
  },

  _restoreChain() {
    var sessionId = this._getSessionId();
    var storedSession = localStorage.getItem('graph.sessionId');
    if (storedSession !== sessionId) {
      localStorage.removeItem('graph.chain');
      localStorage.removeItem('graph.sessionId');
      return;
    }

    var saved = localStorage.getItem('graph.chain');
    if (!saved) return;

    var indices;
    try { indices = JSON.parse(saved); } catch (e) { return; }
    if (!Array.isArray(indices) || indices.length === 0) return;

    for (var i = 0; i < indices.length; i++) {
      var idx = indices[i];
      if (idx < 0 || idx >= this._nodes.length) {
        this._clearChain();
        return;
      }

      if (i === 0) {
        this._nodes[idx].active = true;
        this._nodes[idx].targetColor.setHex(this._activeColor);
        this._nodes[idx].labelTargetColor.setHex(0x111111);
        this._nodes[idx].mesh.material.color.setHex(this._activeColor);
        this._sequence.push(idx);
      } else {
        var prevIdx = indices[i - 1];
        this._addEdge(prevIdx, idx);
        this._nodes[idx].active = true;
        this._nodes[idx].targetColor.setHex(this._activeColor);
        this._nodes[idx].labelTargetColor.setHex(0x111111);
        this._nodes[idx].mesh.material.color.setHex(this._activeColor);
        this._sequence.push(idx);
      }
    }

    this._updateHeadRing();
    this._sendSequence();
  },

  step(stepIndex) {
    if (this._sequence.length === 0) return;

    this._cursor = stepIndex % this._sequence.length;
    var nodeIndex = this._sequence[this._cursor];
    this._popNode(nodeIndex);
  },

  _bgColor: new THREE.Color(0x111111),
  _dimmedColor: new THREE.Color(),
  _dimmedLabelColor: new THREE.Color(),

  update(delta, transport) {
    if (!this._chainRestored && this._getSessionId()) {
      this._chainRestored = true;
      this._restoreChain();
    }

    var stiffness = 300;
    var damping   = 12;
    var colorLerp = Math.min(1, delta * 20);
    var dim = this._context.scene.userData.dimFactor ?? 1.0;

    for (var i = 0; i < this._nodes.length; i++) {
      var node = this._nodes[i];
      var target = i === this._hoveredIndex ? 1.15 : 1.0;

      var displacement = node.springScale - target;
      var force = -stiffness * displacement - damping * node.springVelocity;
      node.springVelocity += force * delta;
      node.springScale    += node.springVelocity * delta;

      var s = node.springScale;
      node.mesh.scale.set(s, s, 1);
      node.labelSprite.scale.set(64 * s, 22 * s, 1);

      this._dimmedColor.copy(node.targetColor).lerp(this._bgColor, 1 - dim);
      this._dimmedLabelColor.copy(node.labelTargetColor).lerp(this._bgColor, 1 - dim);

      node.mesh.material.color.lerp(this._dimmedColor, colorLerp);
      node.labelSprite.material.color.lerp(this._dimmedLabelColor, colorLerp);
    }

    // Dim edges and head ring too
    for (var j = 0; j < this._edges.length; j++) {
      this._dimmedColor.set(0x555555).lerp(this._bgColor, 1 - dim);
      this._edges[j].line.material.color.lerp(this._dimmedColor, colorLerp);
    }
    if (this._headRing) {
      this._dimmedColor.set(0xffffff).lerp(this._bgColor, 1 - dim);
      this._headRing.material.color.lerp(this._dimmedColor, colorLerp);
    }
  },

  pause() {},
  resume() {},

  destroy() {
    this._unbindEvents();
    if (this._unsubscribeScale) this._unsubscribeScale();
  },
});
