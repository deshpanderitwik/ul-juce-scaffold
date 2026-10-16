// The look every animation shares: monochrome on black, with one accent, the
// Listening Room orange (#ff6e35, the same --accent as the personal website).
// Greys are white at an alpha rather than fixed hex values, so a shape reads
// the same over black and over whatever an alpha export is composited onto.
//
//   g.strokeStyle = Theme.ink(0.5);
//   g.fillStyle = Theme.accent();
(() => {
'use strict';

const rgba = (c, a = 1) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
const INK = [255, 255, 255];
const ACCENT = [255, 110, 53];

window.Theme = {
  bg: '#000',
  INK,
  ACCENT,
  ink: (a = 1) => rgba(INK, a),
  accent: (a = 1) => rgba(ACCENT, a),
  rgba,
  // Line weight at 1080p; scale by height / 1080 for other sizes.
  stroke: 3,
};
})();
