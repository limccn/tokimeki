import { describe, expect, it } from "vitest";

import {
  computeCamera,
  computeViewportFrame,
  mapLocalToLogical,
  mapLogicalToLocal,
  visibleLogicalRect,
} from "./geometry.js";

const logical = { cols: 120, rows: 40 };

describe("viewport geometry", () => {
  it("splits viewport, log panel, and status bar", () => {
    const frame = computeViewportFrame({ cols: 100, rows: 30 }, logical, 8);
    expect(frame.viewport).toEqual({ x: 0, y: 0, cols: 100, rows: 21 });
    expect(frame.logPanel).toEqual({ x: 0, y: 21, cols: 100, rows: 8 });
    expect(frame.statusBar).toEqual({ x: 0, y: 29, cols: 100, rows: 1 });
  });

  it("clamps the log panel so the viewport keeps one row", () => {
    const frame = computeViewportFrame({ cols: 80, rows: 10 }, logical, 8);
    expect(frame.logRows).toBe(8);
    expect(frame.viewport.rows).toBe(1);
    expect(frame.statusBar.y).toBe(9);

    const tiny = computeViewportFrame({ cols: 20, rows: 1 }, logical, 8);
    expect(tiny.logRows).toBe(0);
    expect(tiny.viewport.rows).toBe(0);
    expect(tiny.statusBar.y).toBe(0);
  });

  it("centers the logical grid when the viewport fits it", () => {
    const frame = computeViewportFrame({ cols: 140, rows: 50 }, logical, 8);
    expect(frame.viewport).toEqual({ x: 0, y: 0, cols: 140, rows: 41 });
    const camera = computeCamera(logical, frame.viewport, { x: 60, y: 20 });
    expect(camera).toEqual({ x: 0, y: 0, offsetX: 10, offsetY: 0, fitsX: true, fitsY: true });
    expect(visibleLogicalRect(logical, frame.viewport, camera)).toEqual({
      x: 0,
      y: 0,
      cols: 120,
      rows: 40,
    });
  });

  it("crops and follows the cursor on both axes", () => {
    const frame = computeViewportFrame({ cols: 100, rows: 30 }, logical, 8);
    const topLeft = computeCamera(logical, frame.viewport, { x: 0, y: 0 });
    expect(topLeft).toMatchObject({ x: 0, y: 0, fitsX: false, fitsY: false });

    const initial = computeCamera(logical, frame.viewport, { x: 60, y: 20 });
    expect(initial).toMatchObject({ x: 10, y: 10, offsetX: 0, offsetY: 0 });

    const bottomRight = computeCamera(logical, frame.viewport, { x: 119, y: 39 }, initial);
    expect(bottomRight).toMatchObject({ x: 20, y: 19 });

    const visible = visibleLogicalRect(logical, frame.viewport, initial);
    expect(visible).toEqual({ x: 10, y: 10, cols: 100, rows: 21 });
  });

  it("maps local cells through letterbox and camera offsets", () => {
    const fitted = computeViewportFrame({ cols: 140, rows: 50 }, logical, 8);
    const fitCamera = computeCamera(logical, fitted.viewport, { x: 0, y: 0 });
    expect(mapLocalToLogical(fitted, fitCamera, 0, 0)).toBeNull(); // left letterbox
    expect(mapLocalToLogical(fitted, fitCamera, 10, 0)).toEqual({ x: 0, y: 0 });
    expect(mapLogicalToLocal(fitted, fitCamera, 119, 39)).toEqual({ x: 129, y: 39 });

    const cropped = computeViewportFrame({ cols: 100, rows: 30 }, logical, 8);
    const camera = computeCamera(logical, cropped.viewport, { x: 60, y: 20 }, fitCamera);
    expect(mapLocalToLogical(cropped, camera, 0, 0)).toEqual({ x: 10, y: 10 });
    expect(mapLocalToLogical(cropped, camera, 99, 20)).toEqual({ x: 109, y: 30 });
    expect(mapLocalToLogical(cropped, camera, 100, 0)).toBeNull(); // outside viewport
    expect(mapLogicalToLocal(cropped, camera, 10, 10)).toEqual({ x: 0, y: 0 });
    expect(mapLogicalToLocal(cropped, camera, 0, 0)).toBeNull();
  });
});
