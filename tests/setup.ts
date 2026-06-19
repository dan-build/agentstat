// tests/setup.ts
//
// happy-dom returns null from HTMLCanvasElement.getContext('2d'), which means
// AgentStat's animate() loop bails out before populating liveValuesRef.
// This file stubs out a no-op 2D context so animate() runs to completion in
// tests — no pixels get drawn (nobody's looking), but every side-effect in
// the loop (refs, lerps, status copies) works correctly.

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
  HTMLCanvasElement.prototype.getContext = (function () {
    return makeContextMock();
  } as unknown) as typeof HTMLCanvasElement.prototype.getContext;
});
