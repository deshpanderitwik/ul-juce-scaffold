Shell.register({
  id:          'graph',
  name:        'Graph',
  description: 'Build a chain across two rings of scale-degree nodes',

  _group: null,
  _context: null,
  _unsubscribeScale: null,
  _onPointerDown: null,
  _onPointerMove: null,
  _onPointerUp: null,
  _onPointerCancel: null,
  _onDblClick: null,
  _hoveredIndex: -1,
  _isPressed: false,
  _pressIndex: -1,
  _pressX: 0,
  _pressY: 0,
  _dragThreshold: 5,
  _isDragging: false,
  _dragSourceIndex: -1,
  _drag: null,

  // Chewing-gum drag tuning
  _pExponent:        0.60,
  _strainThreshold:  30,
  _breakDuration:    280,
  _dropDuration:     150,
  _cancelDuration:   220,
  _strandBaseWidth:  9,
  _strandSegments:   16,

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

    this._onPointerDown   = function (e) { self._handlePointerDown(e); };
    this._onPointerMove   = function (e) { self._handlePointerMove(e); };
    this._onPointerUp     = function (e) { self._handlePointerUp(e); };
    this._onPointerCancel = function (e) { self._handlePointerCancel(e); };
    this._onDblClick      = function (e) { self._handleDblClick(e); };

    canvas.addEventListener('pointerdown',   this._onPointerDown);
    canvas.addEventListener('pointermove',   this._onPointerMove);
    canvas.addEventListener('pointerup',     this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
    canvas.addEventListener('dblclick',      this._onDblClick);
  },

  _unbindEvents() {
    var canvas = this._context.renderer.domElement;
    if (this._onPointerDown)   canvas.removeEventListener('pointerdown',   this._onPointerDown);
    if (this._onPointerMove)   canvas.removeEventListener('pointermove',   this._onPointerMove);
    if (this._onPointerUp)     canvas.removeEventListener('pointerup',     this._onPointerUp);
    if (this._onPointerCancel) canvas.removeEventListener('pointercancel', this._onPointerCancel);
    if (this._onDblClick)      canvas.removeEventListener('dblclick',      this._onDblClick);
  },

  _clientToWorld(e) {
    var rect = this._context.renderer.domElement.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: rect.height - (e.clientY - rect.top)
    };
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

  _handlePointerDown(e) {
    if (e.button !== 0) return;
    var rect = this._context.renderer.domElement.getBoundingClientRect();
    this._pressX = e.clientX - rect.left;
    this._pressY = e.clientY - rect.top;
    this._pressIndex = this._hitTest(e);
    this._isPressed = true;
    try { this._context.renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
    this._updateCursor();
  },

  _handlePointerUp(e) {
    if (!this._isPressed) return;

    var wasDragging  = this._isDragging;
    var dragSource   = this._dragSourceIndex;
    this._isPressed       = false;
    this._isDragging      = false;
    this._dragSourceIndex = -1;
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}

    if (e.button !== 0) {
      this._pressIndex = -1;
      this._updateCursor();
      return;
    }

    if (wasDragging) {
      if (this._drag && this._drag.phase === 'following') {
        var target = this._hitTest(e);
        if (target !== -1 && target !== dragSource && !this._nodes[target].active) {
          this._startDrop(target);
        } else {
          this._startCancel();
        }
      } else if (this._drag) {
        // Released mid-stretch or mid-break — animate back to clean.
        this._startSnapback();
      }
    } else {
      var rect = this._context.renderer.domElement.getBoundingClientRect();
      var dx = (e.clientX - rect.left) - this._pressX;
      var dy = (e.clientY - rect.top)  - this._pressY;
      var t = this._dragThreshold;
      if (dx * dx + dy * dy <= t * t) {
        this._handleClick(e);
      }
    }

    this._pressIndex = -1;
    this._updateCursor();
  },

  _handlePointerCancel(e) {
    this._isPressed       = false;
    this._isDragging      = false;
    this._dragSourceIndex = -1;
    this._pressIndex      = -1;
    this._destroyDrag();
    try { this._context.renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) {}
    this._updateCursor();
  },

  _isValidDropTarget(idx) {
    if (idx === -1) return false;
    if (idx === this._dragSourceIndex) return false;
    return !this._nodes[idx].active;
  },

  _updateCursor() {
    var canvas = this._context.renderer.domElement;
    var cursor = '';
    if (this._isDragging) {
      cursor = 'grabbing';
    } else if (this._isPressed
        && this._pressIndex !== -1
        && this._nodes[this._pressIndex]
        && this._nodes[this._pressIndex].active) {
      cursor = 'grabbing';
    } else if (this._hoveredIndex !== -1) {
      cursor = this._nodes[this._hoveredIndex].active ? 'grab' : 'pointer';
    }
    canvas.style.cursor = cursor;
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

  _handlePointerMove(e) {
    // Detect drag entry: pressed on an active node + moved past threshold
    if (this._isPressed && !this._isDragging && this._pressIndex !== -1) {
      var src = this._nodes[this._pressIndex];
      if (src && src.active) {
        var rect = this._context.renderer.domElement.getBoundingClientRect();
        var dx = (e.clientX - rect.left) - this._pressX;
        var dy = (e.clientY - rect.top)  - this._pressY;
        var t = this._dragThreshold;
        if (dx * dx + dy * dy > t * t) {
          this._isDragging = true;
          this._dragSourceIndex = this._pressIndex;
          var w = this._clientToWorld(e);
          this._initDrag(this._pressIndex, w.x, w.y);
        }
      }
    }

    if (this._isDragging) {
      var w2 = this._clientToWorld(e);
      this._updateDragCursor(w2.x, w2.y);
    }

    var hit = this._hitTest(e);
    if (this._isDragging && hit !== -1 && !this._isValidDropTarget(hit)) {
      hit = -1;
    }
    if (hit !== this._hoveredIndex) {
      this._hoveredIndex = hit;
    }
    this._updateCursor();
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

  _replaceNodeInSequence(sourceIdx, targetIdx) {
    var seqPos = this._sequence.indexOf(sourceIdx);
    if (seqPos === -1) return;

    this._sequence[seqPos] = targetIdx;

    var src = this._nodes[sourceIdx];
    var tgt = this._nodes[targetIdx];
    src.active = false;
    src.targetColor.setHex(this._inactiveColor);
    src.labelTargetColor.setHex(0xaaaaaa);
    tgt.active = true;
    tgt.targetColor.setHex(this._activeColor);
    tgt.labelTargetColor.setHex(0x111111);
    // Spring pops are driven by ball-animation milestones (source on detach,
    // target on absorb arrival).

    for (var i = 0; i < this._edges.length; i++) {
      var edge = this._edges[i];
      var changed = false;
      if (edge.fromIndex === sourceIdx) { edge.fromIndex = targetIdx; changed = true; }
      if (edge.toIndex   === sourceIdx) { edge.toIndex   = targetIdx; changed = true; }
      if (changed) {
        var a = this._nodes[edge.fromIndex];
        var b = this._nodes[edge.toIndex];
        var pts = [
          new THREE.Vector3(a.x, a.y, 0.05),
          new THREE.Vector3(b.x, b.y, 0.05)
        ];
        edge.line.geometry.dispose();
        edge.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      }
    }

    this._updateHeadRing();
    this._sendSequence();
  },

  // ==================================================================
  // Chewing-gum drag mechanic
  //
  // Phases:
  //   stretching — source's perimeter vertices deform into a tongue;
  //                apex distance follows cursor sub-linearly (a = r + (d−r)^p).
  //   breaking   — strain (d − a) exceeded threshold; tongue retracts to
  //                source's perimeter, bud emerges at cursor, strand forms.
  //   following  — source is a clean circle; bud follows cursor; strand stretches.
  //   dropping   — released on valid target; bud animates to target center
  //                and shrinks into it, strand follows.
  //   cancelling — released elsewhere; bud retracts back to source.
  // ==================================================================

  _initDrag(sourceIdx, worldX, worldY) {
    if (this._drag) this._destroyDrag();

    var srcNode = this._nodes[sourceIdx];
    var radius  = srcNode.ring === 0 ? this._nodeRadiusInner : this._nodeRadius;

    // Cache source's original vertex positions for restoration.
    var sourceOrigPositions = new Float32Array(
      srcNode.mesh.geometry.attributes.position.array
    );

    // Bud mesh — invisible until the break fires.
    var budGeo  = new THREE.CircleGeometry(radius, 32);
    var budMat  = new THREE.MeshBasicMaterial({ color: this._activeColor });
    var budMesh = new THREE.Mesh(budGeo, budMat);
    budMesh.position.set(worldX, worldY, 0.5);
    budMesh.scale.set(0.001, 0.001, 1);
    budMesh.visible = false;
    this._group.add(budMesh);

    // Strand mesh — tapered strip, also invisible until needed.
    var N = this._strandSegments;
    var strandPositions = new Float32Array((N + 1) * 2 * 3);
    var strandIndices   = [];
    for (var si = 0; si < N; si++) {
      strandIndices.push(si * 2,     si * 2 + 1, (si + 1) * 2);
      strandIndices.push((si + 1) * 2, si * 2 + 1, (si + 1) * 2 + 1);
    }
    var strandGeo = new THREE.BufferGeometry();
    strandGeo.setAttribute('position', new THREE.BufferAttribute(strandPositions, 3));
    strandGeo.setIndex(strandIndices);
    var strandMat = new THREE.MeshBasicMaterial({
      color:       this._activeColor,
      side:        THREE.DoubleSide,
      transparent: true   // sort with labels in transparent pass so labels stay on top
    });
    var strandMesh = new THREE.Mesh(strandGeo, strandMat);
    strandMesh.visible = false;
    this._group.add(strandMesh);

    this._drag = {
      sourceIdx:        sourceIdx,
      phase:            'stretching',
      cursorX:          worldX,
      cursorY:          worldY,
      sourceRadius:     radius,
      sourceApex:       radius,
      sourceOrigPos:    sourceOrigPositions,
      budMesh:          budMesh,
      budScale:         0,
      strandMesh:       strandMesh,
      strandPositions:  strandPositions,
      elapsed:          0,
      duration:         0,
      targetIdx:        -1,
      targetPopped:     false
    };
  },

  _updateDragCursor(worldX, worldY) {
    var d = this._drag;
    if (!d) return;
    // Allow cursor to track during all active drag phases, including the
    // break — otherwise the bud freezes for 280ms while phase B animates,
    // then teleports to the new cursor when phase C kicks in.
    if (d.phase !== 'stretching' && d.phase !== 'following' && d.phase !== 'breaking') return;
    d.cursorX = worldX;
    d.cursorY = worldY;
  },

  _startDrop(targetIdx) {
    var d = this._drag;
    if (!d) return;
    this._replaceNodeInSequence(d.sourceIdx, targetIdx);
    var tgt = this._nodes[targetIdx];
    d.phase          = 'dropping';
    d.dropFromX      = d.budMesh.position.x;
    d.dropFromY      = d.budMesh.position.y;
    d.dropToX        = tgt.x;
    d.dropToY        = tgt.y;
    d.targetIdx      = targetIdx;
    d.targetPopped   = false;
    d.elapsed        = 0;
    d.duration       = this._dropDuration;
  },

  _startCancel() {
    var d = this._drag;
    if (!d) return;
    d.phase        = 'cancelling';
    d.cancelFromX  = d.budMesh.position.x;
    d.cancelFromY  = d.budMesh.position.y;
    d.elapsed      = 0;
    d.duration     = this._cancelDuration;
  },

  // Released during stretching or breaking — animate back to clean instead
  // of snapping instantly. Source's tongue retracts; any partial bud merges
  // back into the source.
  _startSnapback() {
    var d = this._drag;
    if (!d) return;
    var src = this._nodes[d.sourceIdx];

    d.snapApexStart     = d.sourceApex;
    d.snapBudScaleStart = d.budScale;
    d.snapBudFromX      = d.budMesh.position.x;
    d.snapBudFromY      = d.budMesh.position.y;

    if (d.breakDirX !== undefined) {
      d.snapDirX = d.breakDirX;
      d.snapDirY = d.breakDirY;
    } else {
      var sdx  = d.cursorX - src.x;
      var sdy  = d.cursorY - src.y;
      var sd   = Math.sqrt(sdx * sdx + sdy * sdy);
      d.snapDirX = sd > 0.001 ? sdx / sd : 1;
      d.snapDirY = sd > 0.001 ? sdy / sd : 0;
    }

    d.phase    = 'snapback';
    d.elapsed  = 0;
    d.duration = 180;
  },

  _destroyDrag() {
    if (!this._drag) return;
    var d = this._drag;
    this._restoreSourceGeometry();
    this._group.remove(d.budMesh);
    d.budMesh.geometry.dispose();
    d.budMesh.material.dispose();
    this._group.remove(d.strandMesh);
    d.strandMesh.geometry.dispose();
    d.strandMesh.material.dispose();
    this._drag = null;
  },

  _deformSourceGeometry(dirX, dirY, apex) {
    var d = this._drag;
    if (!d) return;
    var src = this._nodes[d.sourceIdx];
    var positions = src.mesh.geometry.attributes.position.array;
    var orig = d.sourceOrigPos;
    var r = d.sourceRadius;

    if (apex <= r + 0.01) {
      positions.set(orig);
      src.mesh.geometry.attributes.position.needsUpdate = true;
      return;
    }

    var phi    = Math.atan2(dirY, dirX);
    var cosPhi = Math.cos(phi);
    var sinPhi = Math.sin(phi);

    var nVerts = positions.length / 3;
    for (var i = 1; i < nVerts; i++) {  // skip center vertex (index 0)
      var ox = orig[i * 3];
      var oy = orig[i * 3 + 1];
      var theta = Math.atan2(oy, ox);
      var delta = theta - phi;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;

      if (Math.abs(delta) > Math.PI / 2) {
        positions[i * 3]     = ox;
        positions[i * 3 + 1] = oy;
      } else {
        var alpha   = (delta + Math.PI / 2) / Math.PI;
        var forward = apex * Math.sin(Math.PI * alpha);
        var perp    = -r * Math.cos(Math.PI * alpha);
        positions[i * 3]     = forward * cosPhi - perp * sinPhi;
        positions[i * 3 + 1] = forward * sinPhi + perp * cosPhi;
      }
    }
    src.mesh.geometry.attributes.position.needsUpdate = true;
  },

  _restoreSourceGeometry() {
    var d = this._drag;
    if (!d || !d.sourceOrigPos) return;
    var src = this._nodes[d.sourceIdx];
    if (!src) return;
    var positions = src.mesh.geometry.attributes.position.array;
    positions.set(d.sourceOrigPos);
    src.mesh.geometry.attributes.position.needsUpdate = true;
  },

  _updateStrandGeometry(apexX, apexY, budX, budY, budRadius) {
    var d = this._drag;
    if (!d) return;
    var positions = d.strandPositions;
    var N = this._strandSegments;

    var dx = budX - apexX;
    var dy = budY - apexY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001 || budRadius < 0.5) {
      d.strandMesh.visible = false;
      return;
    }
    d.strandMesh.visible = true;

    var ux = dx / dist;
    var uy = dy / dist;
    var px = -uy;
    var py =  ux;

    // Strand connects to bud's source-facing perimeter.
    var budConnectX = budX - ux * budRadius;
    var budConnectY = budY - uy * budRadius;

    var stretchFactor = Math.max(0.30, 1 - dist / 140);
    // Strand renders over node fills and head rings, but under labels (0.20)
    // and the bud (0.50). Reads as "in transit, in front of the chain."
    var z = 0.18;

    for (var i = 0; i <= N; i++) {
      var u  = i / N;
      var cx = apexX + (budConnectX - apexX) * u;
      var cy = apexY + (budConnectY - apexY) * u;
      var bell = 1 - 0.35 * Math.sin(Math.PI * u);
      var w  = this._strandBaseWidth * 0.5 * stretchFactor * bell;

      var topIdx = (i * 2) * 3;
      var botIdx = (i * 2 + 1) * 3;
      positions[topIdx]     = cx + px * w;
      positions[topIdx + 1] = cy + py * w;
      positions[topIdx + 2] = z;
      positions[botIdx]     = cx - px * w;
      positions[botIdx + 1] = cy - py * w;
      positions[botIdx + 2] = z;
    }
    d.strandMesh.geometry.attributes.position.needsUpdate = true;
  },

  _updateDrag(delta) {
    var d = this._drag;
    if (!d) return;
    d.elapsed += delta * 1000;
    var src = this._nodes[d.sourceIdx];
    if (!src) return;

    if (d.phase === 'stretching') {
      var dx = d.cursorX - src.x;
      var dy = d.cursorY - src.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var apex = d.sourceRadius;
      if (dist > d.sourceRadius) {
        apex = d.sourceRadius + Math.pow(dist - d.sourceRadius, this._pExponent);
      }
      d.sourceApex = apex;

      var dirX = dist > 0.001 ? dx / dist : 1;
      var dirY = dist > 0.001 ? dy / dist : 0;
      this._deformSourceGeometry(dirX, dirY, apex);

      d.budMesh.visible    = false;
      d.strandMesh.visible = false;

      var strain = dist - apex;
      if (strain > this._strainThreshold) {
        d.phase            = 'breaking';
        d.breakApexStart   = apex;
        // Lock the tongue's retraction direction at break time. The source
        // physically "snaps" along the pull axis it was being stretched on,
        // regardless of where the cursor wanders during the 280ms animation.
        d.breakDirX        = dirX;
        d.breakDirY        = dirY;
        d.elapsed          = 0;
        d.duration         = this._breakDuration;
      }
    } else if (d.phase === 'breaking') {
      var bt = Math.min(1, d.elapsed / d.duration);
      var be = 1 - (1 - bt) * (1 - bt);  // easeOutQuad

      // Source's tongue retracts in the locked direction.
      d.sourceApex = d.breakApexStart + (d.sourceRadius - d.breakApexStart) * be;
      this._deformSourceGeometry(d.breakDirX, d.breakDirY, d.sourceApex);

      // Bud is "in the user's hand" — it tracks the live cursor.
      d.budScale = be;
      d.budMesh.position.set(d.cursorX, d.cursorY, 0.5);
      d.budMesh.scale.set(d.budScale, d.budScale, 1);
      d.budMesh.visible = d.budScale > 0.05;

      if (d.budScale > 0.05) {
        var bSrcScale = src.springScale || 1.0;
        var apexX = src.x + d.breakDirX * d.sourceApex * bSrcScale;
        var apexY = src.y + d.breakDirY * d.sourceApex * bSrcScale;
        this._updateStrandGeometry(apexX, apexY, d.cursorX, d.cursorY,
                                   d.sourceRadius * d.budScale);
      } else {
        d.strandMesh.visible = false;
      }

      if (bt >= 1) {
        d.phase = 'following';
        this._restoreSourceGeometry();
      }
    } else if (d.phase === 'following') {
      d.budScale = 1;
      d.budMesh.position.set(d.cursorX, d.cursorY, 0.5);
      d.budMesh.scale.set(1, 1, 1);
      d.budMesh.visible = true;

      var fdx = d.cursorX - src.x;
      var fdy = d.cursorY - src.y;
      var fdist = Math.sqrt(fdx * fdx + fdy * fdy);
      // Anchor strand at source's *current* visible edge (sourceRadius scaled
      // by the spring pop), so the strand stays attached as the source pulses
      // during step-sequencer playback. Otherwise a gap appears when the
      // node dips below scale 1.0.
      var fSrcScale = src.springScale || 1.0;
      var fAnchor   = d.sourceRadius * fSrcScale;
      if (fdist > fAnchor) {
        var fdirX = fdx / fdist;
        var fdirY = fdy / fdist;
        var fApexX = src.x + fdirX * fAnchor;
        var fApexY = src.y + fdirY * fAnchor;
        this._updateStrandGeometry(fApexX, fApexY, d.cursorX, d.cursorY, d.sourceRadius);
      } else {
        d.strandMesh.visible = false;
      }
    } else if (d.phase === 'dropping') {
      var dt = Math.min(1, d.elapsed / d.duration);
      var de = 1 - (1 - dt) * (1 - dt);  // easeOutQuad — fast zip, soft landing
      var dx2 = d.dropFromX + (d.dropToX - d.dropFromX) * de;
      var dy2 = d.dropFromY + (d.dropToY - d.dropFromY) * de;

      d.budScale = dt < 0.6 ? 1 : Math.max(0, 1 - (dt - 0.6) / 0.4);
      d.budMesh.position.set(dx2, dy2, 0.5);
      d.budMesh.scale.set(d.budScale, d.budScale, 1);
      d.budMesh.visible = d.budScale > 0.05;

      if (d.budScale > 0.05) {
        var ddx = dx2 - src.x;
        var ddy = dy2 - src.y;
        var ddist = Math.sqrt(ddx * ddx + ddy * ddy);
        var dSrcScale = src.springScale || 1.0;
        var dAnchor   = d.sourceRadius * dSrcScale;
        if (ddist > dAnchor) {
          var ddirX = ddx / ddist;
          var ddirY = ddy / ddist;
          var dApexX = src.x + ddirX * dAnchor;
          var dApexY = src.y + ddirY * dAnchor;
          this._updateStrandGeometry(dApexX, dApexY, dx2, dy2,
                                     d.sourceRadius * d.budScale);
        } else {
          d.strandMesh.visible = false;
        }
      } else {
        d.strandMesh.visible = false;
      }

      if (dt >= 0.7 && !d.targetPopped) {
        d.targetPopped = true;
        this._popNode(d.targetIdx);
      }
      if (dt >= 1) this._destroyDrag();
    } else if (d.phase === 'cancelling') {
      var ct = Math.min(1, d.elapsed / d.duration);
      var ce = 1 - (1 - ct) * (1 - ct);  // easeOutQuad
      var cx2 = d.cancelFromX + (src.x - d.cancelFromX) * ce;
      var cy2 = d.cancelFromY + (src.y - d.cancelFromY) * ce;

      d.budScale = Math.max(0, 1 - ce);
      d.budMesh.position.set(cx2, cy2, 0.5);
      d.budMesh.scale.set(d.budScale, d.budScale, 1);
      d.budMesh.visible = d.budScale > 0.05;

      if (d.budScale > 0.05) {
        var cdx = cx2 - src.x;
        var cdy = cy2 - src.y;
        var cdist = Math.sqrt(cdx * cdx + cdy * cdy);
        var cSrcScale = src.springScale || 1.0;
        var cAnchor   = d.sourceRadius * cSrcScale;
        if (cdist > cAnchor) {
          var cdirX = cdx / cdist;
          var cdirY = cdy / cdist;
          var cApexX = src.x + cdirX * cAnchor;
          var cApexY = src.y + cdirY * cAnchor;
          this._updateStrandGeometry(cApexX, cApexY, cx2, cy2,
                                     d.sourceRadius * d.budScale);
        } else {
          d.strandMesh.visible = false;
        }
      } else {
        d.strandMesh.visible = false;
      }

      if (ct >= 1) {
        this._popNode(d.sourceIdx);
        this._destroyDrag();
      }
    } else if (d.phase === 'snapback') {
      var st = Math.min(1, d.elapsed / d.duration);
      var se = 1 - (1 - st) * (1 - st);  // easeOutQuad

      // Bud (if any) merges back to source.
      var sbX = d.snapBudFromX + (src.x - d.snapBudFromX) * se;
      var sbY = d.snapBudFromY + (src.y - d.snapBudFromY) * se;
      d.budScale = d.snapBudScaleStart * (1 - se);

      // Source's tongue retracts; direction follows the returning bud so the
      // strand stays oriented sensibly even if the cursor wandered.
      d.sourceApex = d.snapApexStart + (d.sourceRadius - d.snapApexStart) * se;
      var sbdx = sbX - src.x;
      var sbdy = sbY - src.y;
      var sbd  = Math.sqrt(sbdx * sbdx + sbdy * sbdy);
      var sDirX = sbd > 0.001 ? sbdx / sbd : d.snapDirX;
      var sDirY = sbd > 0.001 ? sbdy / sbd : d.snapDirY;
      this._deformSourceGeometry(sDirX, sDirY, d.sourceApex);

      d.budMesh.visible = d.budScale > 0.05;
      if (d.budMesh.visible) {
        d.budMesh.position.set(sbX, sbY, 0.5);
        d.budMesh.scale.set(d.budScale, d.budScale, 1);

        var sSrcScale = src.springScale || 1.0;
        var sAnchor   = d.sourceApex * sSrcScale;
        if (sbd > sAnchor) {
          var sApexX = src.x + sDirX * sAnchor;
          var sApexY = src.y + sDirY * sAnchor;
          this._updateStrandGeometry(sApexX, sApexY, sbX, sbY,
                                     d.sourceRadius * d.budScale);
        } else {
          d.strandMesh.visible = false;
        }
      } else {
        d.strandMesh.visible = false;
      }

      if (st >= 1) {
        this._popNode(d.sourceIdx);
        this._destroyDrag();
      }
    }
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

    this._updateDrag(delta);

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

    if (this._drag) {
      this._dimmedColor.set(this._activeColor).lerp(this._bgColor, 1 - dim);
      if (this._drag.budMesh)    this._drag.budMesh.material.color.lerp(this._dimmedColor, colorLerp);
      if (this._drag.strandMesh) this._drag.strandMesh.material.color.lerp(this._dimmedColor, colorLerp);
    }
  },

  pause() {},
  resume() {},

  destroy() {
    this._unbindEvents();
    if (this._unsubscribeScale) this._unsubscribeScale();
    this._destroyDrag();
  },
});
