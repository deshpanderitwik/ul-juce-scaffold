// ==========================================================================
// Test — exciter moves through key lanes triggering notes
// ==========================================================================

Shell.register({
  id:          'test',
  name:        'Test',
  description: 'Prototyping scratchpad',

  // Private state
  _ctx:              null,
  _lanes:            [],     // { midiNote, degree, mesh, label, yCenter, baseColor, flashColor, flashTimer }
  _dividers:         [],
  _numDegrees:       5,      // root through perfect fifth
  _exciterMesh:      null,
  _exciterY:         0,
  _exciterDir:       1,      // 1 = up, -1 = down
  _exciterSpeed:     200,    // base pixels per second
  _currentLaneIndex: -1,     // which lane the exciter is in
  _repetition:       0,      // current strum repetition
  _maxRepetitions:   8,      // how many strums before resetting
  _unsubscribeScale: null,   // onChange unsubscribe function

  // Layout constants
  _topMargin:    50,     // leave room for the top bar
  _bottomMargin: 20,

  // -- Degree colors (muted, dark — exciter will pop against these) --
  _degreeColors: [
    0x3d1e1e,  // 1 (root)  — deep red
    0x3d2e1e,  // 2         — warm brown
    0x3d3d1e,  // 3         — olive
    0x1e3d1e,  // 4         — forest
    0x1e2e3d,  // 5 (fifth) — steel blue
  ],

  // -- Flash colors (bright, used when a note triggers) --
  _degreeFlashColors: [
    0xff5555,  // 1 — bright red
    0xff9955,  // 2 — bright orange
    0xffff55,  // 3 — bright yellow
    0x55ff55,  // 4 — bright green
    0x55aaff,  // 5 — bright blue
  ],

  // ====================================================================
  // Helpers
  // ====================================================================

  _makeLabel: function (text) {
    var c  = document.createElement('canvas');
    var cx = c.getContext('2d');
    c.width  = 160;
    c.height = 48;
    cx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
    cx.fillStyle = 'rgba(255,255,255,0.4)';
    cx.textBaseline = 'middle';
    cx.fillText(text, 8, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(160, 48, 1);
    return spr;
  },

  _clearLanes: function () {
    for (var i = 0; i < this._lanes.length; i++) {
      this._ctx.scene.remove(this._lanes[i].mesh);
      this._ctx.scene.remove(this._lanes[i].label);
    }
    for (var j = 0; j < this._dividers.length; j++) {
      this._ctx.scene.remove(this._dividers[j]);
    }
    this._lanes    = [];
    this._dividers = [];
  },

  _buildLanes: function () {
    var ctx = this._ctx;
    var size = ctx.getSize();
    var w = size.width;
    var h = size.height;

    var laneAreaHeight = h - this._topMargin - this._bottomMargin;
    var laneHeight     = laneAreaHeight / this._numDegrees;

    for (var d = 1; d <= this._numDegrees; d++) {
      var midiNote = ctx.scale.getNoteForDegree(d, ctx.scale.getBaseOctave());
      var i        = d - 1;
      var yBottom  = this._bottomMargin + i * laneHeight;
      var yCenter  = yBottom + laneHeight / 2;

      // Lane background
      var geo  = new THREE.PlaneGeometry(w * 2, laneHeight);
      var mat  = new THREE.MeshBasicMaterial({ color: this._degreeColors[i] });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(w / 2, yCenter, 0);
      ctx.scene.add(mesh);

      // Note name label (left edge)
      var noteName = ctx.scale.getNoteName(midiNote);
      var label    = this._makeLabel(noteName);
      label.position.set(80, yCenter, 0.1);
      ctx.scene.add(label);

      this._lanes.push({
        midiNote:   midiNote,
        degree:     d,
        mesh:       mesh,
        label:      label,
        yCenter:    yCenter,
        yBottom:    yBottom,
        height:     laneHeight,
        baseColor:  new THREE.Color(this._degreeColors[i]),
        flashColor: new THREE.Color(this._degreeFlashColors[i]),
        flashTimer: 0
      });
    }

    // Divider lines between lanes
    for (var k = 1; k < this._numDegrees; k++) {
      var lineY   = this._bottomMargin + k * laneHeight;
      var lineGeo = new THREE.PlaneGeometry(w * 2, 1);
      var lineMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
      var line    = new THREE.Mesh(lineGeo, lineMat);
      line.position.set(w / 2, lineY, 0.1);
      ctx.scene.add(line);
      this._dividers.push(line);
    }
  },

  // ====================================================================
  // Lifecycle
  // ====================================================================

  _resetExciter: function () {
    if (this._lanes.length > 0) {
      this._exciterY         = this._lanes[0].yCenter;
      this._exciterDir       = 1;
      this._currentLaneIndex = -1;
    }
  },

  init: function (ctx) {
    this._ctx = ctx;
    this._buildLanes();

    // Exciter dot — bright circle, rendered in front of lanes
    var exciterGeo = new THREE.CircleGeometry(10, 32);
    var exciterMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this._exciterMesh = new THREE.Mesh(exciterGeo, exciterMat);
    this._exciterMesh.position.z = 0.5;
    ctx.scene.add(this._exciterMesh);

    // Start at the root lane, moving up
    var size = ctx.getSize();
    this._exciterMesh.position.x = size.width / 2;
    this._resetExciter();

    // Subscribe to scale changes — rebuild lanes live
    var self = this;
    this._unsubscribeScale = ctx.scale.onChange(function () {
      self._clearLanes();
      self._buildLanes();
      self._resetExciter();
    });
  },

  pause:   function () {},
  resume:  function () {},

  destroy: function () {
    this._clearLanes();
    if (this._unsubscribeScale) {
      this._unsubscribeScale();
      this._unsubscribeScale = null;
    }
  },

  update: function (delta, tp) {
    if (!this._exciterMesh || this._lanes.length === 0) return;

    var bottomY = this._lanes[0].yCenter;
    var topY    = this._lanes[this._lanes.length - 1].yCenter;

    // Each repetition gets faster; within each strum, accelerate upward
    var repMultiplier = 1 + this._repetition * 0.6;               // 1x, 1.6x, 2.2x, ... 5.2x
    var progress = (this._exciterY - bottomY) / (topY - bottomY);
    var speed = this._exciterSpeed * repMultiplier * (0.3 + progress * 1.5);
    this._exciterY += speed * delta;

    if (this._exciterY > topY) {
      this._exciterY         = bottomY;
      this._currentLaneIndex = -1;
      this._repetition++;
      if (this._repetition >= this._maxRepetitions) {
        this._repetition = 0;
      }
    }

    this._exciterMesh.position.y = this._exciterY;

    // Determine which lane the exciter is in
    var laneIndex = -1;
    for (var i = 0; i < this._lanes.length; i++) {
      var lane = this._lanes[i];
      if (this._exciterY >= lane.yBottom && this._exciterY < lane.yBottom + lane.height) {
        laneIndex = i;
        break;
      }
    }
    // Handle top edge (exciter at exact top of last lane)
    if (laneIndex === -1 && this._lanes.length > 0) {
      var last = this._lanes[this._lanes.length - 1];
      if (this._exciterY >= last.yBottom) laneIndex = this._lanes.length - 1;
    }

    // Trigger on lane change
    if (laneIndex !== -1 && laneIndex !== this._currentLaneIndex) {
      this._currentLaneIndex = laneIndex;
      var triggered = this._lanes[laneIndex];
      this._ctx.midi.sendNote(triggered.midiNote, 100, 1, 200);
      triggered.flashTimer = 1.0;
    }

    // Decay flash timers and update lane colors
    for (var j = 0; j < this._lanes.length; j++) {
      var ln = this._lanes[j];
      if (ln.flashTimer > 0) {
        ln.flashTimer = Math.max(0, ln.flashTimer - delta * 5); // ~200ms decay
        ln.mesh.material.color.copy(ln.flashColor).lerp(ln.baseColor, 1 - ln.flashTimer);
      }
    }
  }
});
