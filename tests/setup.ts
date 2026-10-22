// tests/setup.ts
//
// happy-dom returns null from HTMLCanvasElement.getContext('2d'), which would
// make AgentStat's render loop bail out before easing live values. This file
// stubs a no-op 2D context so each frame runs to completion in tests — no
// pixels are drawn, but every side effect of the loop works.

import { beforeAll } from 'vitest';

function makeContextMock(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} } as unknown as CanvasGradient;
  const mock = {
    // Writable style props animate() sets
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    shadowBlur: 0,
    shadowColor: '',
    globalAlpha: 1,
    // Methods animate() / resizeCanvas() call
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    arc: () => {},
    rect: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    setLineDash: () => {},
    setTransform: () => {},
    resetTransform: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({
      width: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
    }),
  };
  return mock as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  // Node-environment tests (e.g. SSR) have no DOM to patch.
  if (typeof HTMLCanvasElement === 'undefined') return;
  HTMLCanvasElement.prototype.getContext = (function () {
    return makeContextMock();
  } as unknown) as typeof HTMLCanvasElement.prototype.getContext;
});
