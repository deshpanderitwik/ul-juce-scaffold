// ==========================================================================
// spy.js — loaded first in the experiment list when autotest=1. Wraps
// Shell.register so the autotest can see, without touching any experiment
// file, which experiments define step() and how often the shell called it,
// and whether init() ran before the saved state had arrived.
// Not bundled into the plugin.
// ==========================================================================

(function () {
  'use strict';

  const spy = window.__spy = {
    hasStep:         {},   // id -> does the experiment define step()
    stepCalls:       {},   // id -> number of step() calls
    initBeforeState: {},   // id -> true if init() ran before the `state` event
    inits:           {}    // id -> number of init() calls
  };

  const register = Shell.register;

  Shell.register = function (behavior) {
    if (behavior && behavior.id) {
      const id = behavior.id;
      spy.stepCalls[id] = 0;
      spy.inits[id] = 0;
      spy.hasStep[id] = typeof behavior.step === 'function';

      if (spy.hasStep[id]) {
        const step = behavior.step;
        behavior.step = function () {
          spy.stepCalls[id]++;
          return step.apply(this, arguments);
        };
      }
      if (typeof behavior.init === 'function') {
        const init = behavior.init;
        behavior.init = function () {
          spy.inits[id]++;
          if (!window.__mock || window.__mock.stateAt === null) spy.initBeforeState[id] = true;
          return init.apply(this, arguments);
        };
      }
    }
    return register.apply(this, arguments);
  };
})();
