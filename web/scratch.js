// ==========================================================================
// Scratch — blank experiment, ready for live iteration
// ==========================================================================

const ScratchExperiment = {
  id:          'scratch',
  name:        'Scratch',
  description: 'Blank experiment page',

  _group: null,
  _context: null,
  _unsubscribeScale: null,

  init(context) {
    this._context = context;
    this._group = new THREE.Group();
    context.scene.add(this._group);

    this._unsubscribeScale = context.scale.onChange(() => {
      this._rebuild();
    });

    this._rebuild();
  },

  _rebuild() {
    // Clear existing objects
    while (this._group.children.length) {
      this._group.remove(this._group.children[0]);
    }

    const notes = this._context.scale.getNotesInRange(48, 72);
    // Build your scene here using notes array
  },

  update(delta, transport) {
    // Called every frame — update positions, check triggers, etc.
  },

  pause() {},
  resume() {},

  destroy() {
    if (this._unsubscribeScale) this._unsubscribeScale();
    if (this._group && this._group.parent) {
      this._group.parent.remove(this._group);
    }
  },
};

Shell.register(ScratchExperiment);
