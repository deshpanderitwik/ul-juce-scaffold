const FoundationsExperiment = {
  id:          'scribbler',
  name:        'Scribbler',
  description: 'Gesture through floating note balls',

  _group: null,
  _context: null,
  _unsubscribeScale: null,

  _dragging: false,
  _points: [],
  _activeLine: null,
  _fadingTraces: [],

  _boundDown: null,
  _boundMove: null,
  _boundUp: null,

  _balls: [],
  _ballRadius: 25,

  _dimColor:   0x2a2a3a,
  _flashColor: 0xffffff,

  _ovalRx: 0,
  _ovalRy: 0,
  _ovalLine: null,
  _ovalHitThreshold: 15,
  _resizingOval: false,
  _ovalGrabDist: 0,
  _ovalGrabRx: 0,
  _ovalGrabRy: 0,
  _ovalMinScale: 0.15,
  _ovalMaxScale: 0.48,

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._unsubscribeScale = context.scale.onChange(() => {
      this._rebuild();
    });

    this._rebuild();

    var self = this;
    this._boundDown = function (e) { self._onDown(e); };
    this._boundMove = function (e) { self._onMove(e); };
    this._boundUp   = function (e) { self._onUp(e); };

    document.addEventListener('mousedown', this._boundDown, true);
    document.addEventListener('mousemove', this._boundMove, true);
    document.addEventListener('mouseup',   this._boundUp,   true);
  },

  _rebuild() {
    while (this._group.children.length) {
      this._group.remove(this._group.children[0]);
    }
    this._activeLine = null;
    this._fadingTraces = [];
    this._points = [];
    this._balls = [];
    this._ovalLine = null;

    var size = this._context.getSize();
    var padding = 80;
    var usableW = size.width - padding * 2;
    var usableH = size.height - padding * 2;

    if (this._ovalRx === 0) {
      var r = Math.min(usableW, usableH) * 0.38;
      this._ovalRx = r;
      this._ovalRy = r;
    }

    this._buildBalls();
    this._buildOval();
  },

  _buildBalls() {
    var ctx = this._context;
    var size = ctx.getSize();
    var w = size.width;
    var h = size.height;

    var numDegrees = ctx.scale.getScaleLength();
    for (var d = 1; d <= numDegrees; d++) {
      var midiNote = ctx.scale.getNoteForDegree(d, ctx.scale.getBaseOctave());

      var angle = ((d - 1) / numDegrees) * Math.PI * 2 - Math.PI / 2;
      var cx = w / 2 + Math.cos(angle) * this._ovalRx;
      var cy = h / 2 + Math.sin(angle) * this._ovalRy;

      var geo = new THREE.CircleGeometry(this._ballRadius, 32);
      var mat = new THREE.MeshBasicMaterial({ color: this._dimColor });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, cy, 1);
      this._group.add(mesh);

      var noteName = ctx.scale.getNoteName(midiNote);
      var label = this._makeLabel(noteName, 'rgba(255,255,255,0.7)');
      label.position.set(cx, cy, 1.1);
      this._group.add(label);

      var labelDark = this._makeLabel(noteName, 'rgba(0,0,0,0.8)');
      labelDark.position.set(cx, cy, 1.1);
      labelDark.visible = false;
      this._group.add(labelDark);

      this._balls.push({
        mesh: mesh,
        label: label,
        labelDark: labelDark,
        midiNote: midiNote,
        degree: d,
        x: cx,
        y: cy,
        homeX: cx,
        homeY: cy,
        vx: 0,
        vy: 0,
        isActive: false,
        flashTimer: 0
      });
    }
  },

  _buildOval() {
    var size = this._context.getSize();
    var centerX = size.width / 2;
    var centerY = size.height / 2;
    var segments = 64;
    var verts = [];

    for (var i = 0; i <= segments; i++) {
      var angle = (i / segments) * Math.PI * 2;
      verts.push(
        centerX + Math.cos(angle) * this._ovalRx,
        centerY + Math.sin(angle) * this._ovalRy,
        0.05
      );
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

    var mat = new THREE.LineDashedMaterial({
      color: 0x555555,
      transparent: true,
      opacity: 0.4,
      dashSize: 6,
      gapSize: 6
    });

    this._ovalLine = new THREE.LineLoop(geo, mat);
    this._ovalLine.computeLineDistances();
    this._group.add(this._ovalLine);
  },

  _rebuildOval() {
    if (this._ovalLine) {
      this._group.remove(this._ovalLine);
      this._ovalLine.geometry.dispose();
      this._ovalLine.material.dispose();
      this._ovalLine = null;
    }
    this._buildOval();
  },

  _isNearOval(x, y) {
    var size = this._context.getSize();
    var dx = x - size.width / 2;
    var dy = y - size.height / 2;

    var angle = Math.atan2(dy / this._ovalRy, dx / this._ovalRx);
    var ex = this._ovalRx * Math.cos(angle);
    var ey = this._ovalRy * Math.sin(angle);

    var distX = dx - ex;
    var distY = dy - ey;
    return Math.sqrt(distX * distX + distY * distY) < this._ovalHitThreshold;
  },

  _updateBallHomes() {
    var size = this._context.getSize();
    var w = size.width;
    var h = size.height;
    var numDegrees = this._balls.length;

    for (var i = 0; i < numDegrees; i++) {
      var ball = this._balls[i];
      var angle = ((ball.degree - 1) / numDegrees) * Math.PI * 2 - Math.PI / 2;
      ball.homeX = w / 2 + Math.cos(angle) * this._ovalRx;
      ball.homeY = h / 2 + Math.sin(angle) * this._ovalRy;
    }
  },

  _makeLabel(text, color) {
    var c  = document.createElement('canvas');
    var cx = c.getContext('2d');
    c.width  = 64;
    c.height = 32;
    cx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = color || 'rgba(255,255,255,0.7)';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, c.width / 2, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(64, 32, 1);
    return spr;
  },

  _screenToWorld(e) {
    var x = e.clientX;
    var y = window.innerHeight - e.clientY;
    return { x: x, y: y };
  },

  _onDown(e) {
    var tag = (e.target && e.target.tagName) ? e.target.tagName : '';
    if (tag === 'SELECT' || tag === 'BUTTON' || tag === 'OPTION') return;

    var p = this._screenToWorld(e);

    if (this._isNearOval(p.x, p.y)) {
      this._resizingOval = true;
      var size = this._context.getSize();
      var dx = p.x - size.width / 2;
      var dy = p.y - size.height / 2;
      this._ovalGrabDist = Math.sqrt(dx * dx + dy * dy);
      this._ovalGrabRx = this._ovalRx;
      this._ovalGrabRy = this._ovalRy;
      document.body.style.cursor = 'grabbing';
      return;
    }

    this._dragging = true;
    this._points = [];
    this._points.push(p);
    this._checkCollisions(p);
  },

  _onMove(e) {
    var p = this._screenToWorld(e);

    if (this._resizingOval) {
      var size = this._context.getSize();
      var dx = p.x - size.width / 2;
      var dy = p.y - size.height / 2;
      var dist = Math.sqrt(dx * dx + dy * dy);

      var ratio = this._ovalGrabDist > 0 ? dist / this._ovalGrabDist : 1;

      var padding = 80;
      var usableW = size.width - padding * 2;
      var usableH = size.height - padding * 2;
      var usableMin = Math.min(usableW, usableH);
      var maxR = usableMin * this._ovalMaxScale;
      var minR = usableMin * this._ovalMinScale;

      var r = Math.max(minR, Math.min(maxR, this._ovalGrabRx * ratio));
      this._ovalRx = r;
      this._ovalRy = r;

      this._updateBallHomes();
      for (var i = 0; i < this._balls.length; i++) {
        var ball = this._balls[i];
        ball.x = ball.homeX;
        ball.y = ball.homeY;
        ball.vx = 0;
        ball.vy = 0;
        ball.mesh.position.x = ball.x;
        ball.mesh.position.y = ball.y;
        ball.label.position.x = ball.x;
        ball.label.position.y = ball.y;
        ball.labelDark.position.x = ball.x;
        ball.labelDark.position.y = ball.y;
      }
      this._rebuildOval();
      return;
    }

    if (this._dragging) {
      this._points.push(p);
      this._rebuildActiveLine();
      this._checkCollisions(p);
      return;
    }

    if (this._isNearOval(p.x, p.y)) {
      document.body.style.cursor = 'grab';
      if (this._ovalLine) this._ovalLine.material.opacity = 0.7;
    } else {
      document.body.style.cursor = 'default';
      if (this._ovalLine) this._ovalLine.material.opacity = 0.4;
    }
  },

  _onUp(e) {
    if (this._resizingOval) {
      this._resizingOval = false;
      var p = this._screenToWorld(e);
      document.body.style.cursor = this._isNearOval(p.x, p.y) ? 'grab' : 'default';
      return;
    }

    if (!this._dragging) return;
    this._dragging = false;

    if (this._activeLine) {
      this._group.remove(this._activeLine);
      this._activeLine.geometry.dispose();
      this._activeLine.material.dispose();
      this._activeLine = null;
    }

    if (this._points.length >= 2) {
      var line = this._makeLineFromPoints(this._points, 1.0);
      this._group.add(line);
      this._fadingTraces.push({ line: line, opacity: 1.0 });
    }

    this._points = [];

    for (var i = 0; i < this._balls.length; i++) {
      var ball = this._balls[i];
      if (ball.isActive) {
        ball.isActive = false;
        this._context.midi.sendNoteOff(ball.midiNote, 1);
      }
    }
  },

  _checkCollisions(p) {
    for (var i = 0; i < this._balls.length; i++) {
      var ball = this._balls[i];
      var dx = p.x - ball.x;
      var dy = p.y - ball.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var inside = dist < this._ballRadius;

      if (inside && !ball.isActive) {
        ball.isActive = true;
        ball.flashTimer = 1.0;
        this._context.midi.sendNoteOn(ball.midiNote, 100, 1);
      } else if (!inside && ball.isActive) {
        ball.isActive = false;
        this._context.midi.sendNoteOff(ball.midiNote, 1);
      }
    }
  },

  _rebuildActiveLine() {
    if (this._activeLine) {
      this._group.remove(this._activeLine);
      this._activeLine.geometry.dispose();
      this._activeLine.material.dispose();
      this._activeLine = null;
    }

    if (this._points.length < 2) return;

    this._activeLine = this._makeLineFromPoints(this._points, 0.8);
    this._group.add(this._activeLine);
  },

  _makeLineFromPoints(pts, opacity) {
    var verts = [];
    for (var i = 0; i < pts.length; i++) {
      verts.push(pts[i].x, pts[i].y, 0.5);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

    var mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: opacity
    });

    return new THREE.Line(geo, mat);
  },

  update(delta, transport) {
    for (var i = this._fadingTraces.length - 1; i >= 0; i--) {
      var trace = this._fadingTraces[i];
      trace.opacity -= delta * 2.0;
      if (trace.opacity <= 0) {
        this._group.remove(trace.line);
        trace.line.geometry.dispose();
        trace.line.material.dispose();
        this._fadingTraces.splice(i, 1);
      } else {
        trace.line.material.opacity = trace.opacity;
      }
    }

    var dim = new THREE.Color(this._dimColor);
    var flash = new THREE.Color(this._flashColor);
    var driftForce = 3;
    var homeForce = 0.08;
    var damping = 0.97;

    for (var j = 0; j < this._balls.length; j++) {
      var ball = this._balls[j];

      ball.vx += (Math.random() - 0.5) * driftForce * delta;
      ball.vy += (Math.random() - 0.5) * driftForce * delta;

      ball.vx += (ball.homeX - ball.x) * homeForce * delta;
      ball.vy += (ball.homeY - ball.y) * homeForce * delta;

      ball.vx *= damping;
      ball.vy *= damping;

      ball.x += ball.vx;
      ball.y += ball.vy;

      ball.mesh.position.x = ball.x;
      ball.mesh.position.y = ball.y;
      ball.label.position.x = ball.x;
      ball.label.position.y = ball.y;
      ball.labelDark.position.x = ball.x;
      ball.labelDark.position.y = ball.y;

      var lit = ball.isActive || ball.flashTimer > 0.5;
      ball.label.visible = !lit;
      ball.labelDark.visible = lit;

      if (ball.isActive) {
        ball.mesh.material.color.set(this._flashColor);
      } else if (ball.flashTimer > 0) {
        ball.flashTimer = Math.max(0, ball.flashTimer - delta * 3.0);
        ball.mesh.material.color.copy(flash).lerp(dim, 1 - ball.flashTimer);
      }
    }
  },

  pause() {},
  resume() {},

  destroy() {
    for (var i = 0; i < this._balls.length; i++) {
      if (this._balls[i].isActive) {
        this._context.midi.sendNoteOff(this._balls[i].midiNote, 1);
      }
    }

    document.body.style.cursor = 'default';
    if (this._unsubscribeScale) this._unsubscribeScale();
    if (this._boundDown) document.removeEventListener('mousedown', this._boundDown, true);
    if (this._boundMove) document.removeEventListener('mousemove', this._boundMove, true);
    if (this._boundUp)   document.removeEventListener('mouseup',   this._boundUp,   true);

    if (this._group && this._group.parent) {
      this._group.parent.remove(this._group);
    }
  },
};

Shell.register(FoundationsExperiment);
