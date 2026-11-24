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
  it("splits a narrow terminal into viewport and status bar", () => {
    const frame = computeViewportFrame({ cols: 100, rows: 30 }, logical);
    expect(frame.mode).toBe("narrow");
    expect(frame.viewport).toEqual({ x: 0, y: 0, cols: 100, rows: 29 });
    expect(frame.logPanel).toBeNull();
    expect(frame.cornerViewport).toBeNull();
    expect(frame.mergedViewport).toEqual(frame.viewport);
    expect(frame.statusBar).toEqual({ x: 0, y: 29, cols: 100, rows: 1 });
  });

  it("keeps a zero-row viewport on a one-row terminal", () => {
    const tiny = computeViewportFrame({ cols: 20, rows: 1 }, logical);
    expect(tiny.viewport.rows).toBe(0);
    expect(tiny.statusBar.y).toBe(0);
  });

  it("uses an L-shaped viewport and a 40x8 corner log area on wide terminals", () => {
    const frame = computeViewportFrame({ cols: 140, rows: 50 }, logical, { corner: true });
    expect(frame.mode).toBe("corner");
    expect(frame.viewport).toEqual({ x: 0, y: 0, cols: 140, rows: 41 });
    expect(frame.cornerViewport).toEqual({ x: 0, y: 41, cols: 100, rows: 8 });
    expect(frame.logPanel).toEqual({ x: 100, y: 41, cols: 40, rows: 8 });
    expect(frame.mergedViewport).toEqual({ x: 0, y: 0, cols: 140, rows: 49 });
    expect(frame.statusBar).toEqual({ x: 0, y: 49, cols: 140, rows: 1 });
  });

  it("falls back to narrow when the corner would leave no viewport row", () => {
    const frame = computeViewportFrame({ cols: 140, rows: 9 }, logical, { corner: true });
    expect(frame.mode).toBe("narrow");
    expect(frame.logPanel).toBeNull();
  });

  it("centers the logical grid when the merged viewport fits it", () => {
    const frame = computeViewportFrame({ cols: 140, rows: 50 }, logical);
    expect(frame.viewport).toEqual({ x: 0, y: 0, cols: 140, rows: 49 });
    const camera = computeCamera(logical, frame.mergedViewport, { x: 60, y: 20 });
    expect(camera).toEqual({ x: 0, y: 0, offsetX: 10, offsetY: 4, fitsX: true, fitsY: true });
    expect(visibleLogicalRect(logical, frame.mergedViewport, camera)).toEqual({
      x: 0,
      y: 0,
      cols: 120,
      rows: 40,
    });
  });

  it("crops and follows the cursor on both axes", () => {
    const frame = computeViewportFrame({ cols: 100, rows: 30 }, logical);
    const topLeft = computeCamera(logical, frame.mergedViewport, { x: 0, y: 0 });
    expect(topLeft).toMatchObject({ x: 0, y: 0, fitsX: false, fitsY: false });

    const initial = computeCamera(logical, frame.mergedViewport, { x: 60, y: 20 });
    expect(initial).toMatchObject({ x: 10, y: 6, offsetX: 0, offsetY: 0 });

    const bottomRight = computeCamera(logical, frame.mergedViewport, { x: 119, y: 39 }, initial);
    expect(bottomRight).toMatchObject({ x: 20, y: 11 });

    const visible = visibleLogicalRect(logical, frame.mergedViewport, initial);
    expect(visible).toEqual({ x: 10, y: 6, cols: 100, rows: 29 });
  });

  it("maps local cells through letterbox and camera offsets", () => {
    const fitted = computeViewportFrame({ cols: 140, rows: 50 }, logical);
    const fitCamera = computeCamera(logical, fitted.mergedViewport, { x: 0, y: 0 });
    expect(mapLocalToLogical(fitted, fitCamera, 0, 0)).toBeNull(); // left letterbox
    expect(mapLocalToLogical(fitted, fitCamera, 10, 4)).toEqual({ x: 0, y: 0 });
    expect(mapLogicalToLocal(fitted, fitCamera, 119, 39)).toEqual({ x: 129, y: 43 });

    const cropped = computeViewportFrame({ cols: 100, rows: 30 }, logical);
    const camera = computeCamera(logical, cropped.mergedViewport, { x: 60, y: 20 }, fitCamera);
    expect(mapLocalToLogical(cropped, camera, 0, 0)).toEqual({ x: 10, y: 6 });
    expect(mapLocalToLogical(cropped, camera, 99, 20)).toEqual({ x: 109, y: 26 });
    expect(mapLocalToLogical(cropped, camera, 100, 0)).toBeNull(); // outside viewport
    expect(mapLogicalToLocal(cropped, camera, 10, 6)).toEqual({ x: 0, y: 0 });
    expect(mapLogicalToLocal(cropped, camera, 0, 0)).toBeNull();
  });

  it("maps the corner slice but not the corner log area", () => {
    const tall = { cols: 120, rows: 60 };
    const frame = computeViewportFrame({ cols: 140, rows: 50 }, tall, { corner: true });
    const camera = computeCamera(tall, frame.mergedViewport, { x: 0, y: 0 });
    const top = mapLocalToLogical(frame, camera, 10, 10);
    const bottomLeft = mapLocalToLogical(frame, camera, 10, 45);
    expect(top).not.toBeNull();
    expect(bottomLeft).not.toBeNull();
    expect(bottomLeft?.y).toBe(top === null ? null : top.y + 35);
    expect(mapLocalToLogical(frame, camera, 120, 45)).toBeNull(); // under the log area
  });
});
