/**
 * Pure viewport geometry.
 *
 * The local terminal is split into a TUI viewport and a one-line status bar.
 * In debug mode on a wide terminal an additional 40x8 log area occupies the
 * bottom-right corner; the TUI viewport then becomes L-shaped (top full-width
 * slice + bottom-left slice) while the camera is computed over the merged
 * (top + corner-height) rectangle.
 */

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly cols: number;
  readonly rows: number;
}

export type ViewportLayoutMode = "narrow" | "corner";

export interface ViewportLayoutOptions {
  /** Reserve the bottom-right debug log area (wide terminals only). */
  readonly corner?: boolean;
}

export interface ViewportFrame {
  readonly local: TerminalSize;
  readonly logical: TerminalSize;
  readonly mode: ViewportLayoutMode;
  /** Top full-width slice (narrow mode: the only viewport). */
  readonly viewport: Rect;
  /** Bottom-left continuation slice in corner mode (null otherwise). */
  readonly cornerViewport: Rect | null;
  /** Bottom-right debug log area in corner mode (null otherwise). */
  readonly logPanel: Rect | null;
  /** Camera rectangle: viewport + corner height in corner mode. */
  readonly mergedViewport: Rect;
  readonly statusBar: Rect;
}

/** v1.4 constants (not environment-configurable). */
export const CORNER_COLS = 40;
export const CORNER_ROWS = 8;
export const CORNER_MIN_COLS = 120;
export const CORNER_EXIT_COLS = 118;

export interface ViewportCamera {
  /** Camera origin inside the logical grid (0 when the axis fits). */
  readonly x: number;
  readonly y: number;
  /** Letterbox offset inside the viewport when the logical axis fits. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly fitsX: boolean;
  readonly fitsY: boolean;
}

export interface LogicalPoint {
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function clampDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Split the local terminal into viewport / optional corner log / status bar.
 *
 * The corner layout requires at least one viewport row, one status row, the
 * 8-row log area, and enough columns for the 40-column log area plus one
 * viewport column; otherwise it falls back to the narrow layout.
 */
export function computeViewportFrame(
  local: TerminalSize,
  logical: TerminalSize,
  options: ViewportLayoutOptions = {},
): ViewportFrame {
  const localCols = clampDimension(local.cols);
  const localRows = clampDimension(local.rows);
  const statusBar: Rect =
    localRows > 0
      ? { x: 0, y: localRows - 1, cols: localCols, rows: 1 }
      : { x: 0, y: 0, cols: localCols, rows: 0 };
  const cornerPossible =
    options.corner === true && localCols > CORNER_COLS && localRows - 1 > CORNER_ROWS;
  if (cornerPossible) {
    const viewRows = localRows - 1 - CORNER_ROWS;
    const cornerCols = Math.max(1, localCols - CORNER_COLS);
    const viewport: Rect = { x: 0, y: 0, cols: localCols, rows: viewRows };
    const cornerViewport: Rect = {
      x: 0,
      y: viewRows,
      cols: cornerCols,
      rows: CORNER_ROWS,
    };
    const logPanel: Rect = {
      x: localCols - CORNER_COLS,
      y: viewRows,
      cols: CORNER_COLS,
      rows: CORNER_ROWS,
    };
    return {
      local: { cols: localCols, rows: localRows },
      logical,
      mode: "corner",
      viewport,
      cornerViewport,
      logPanel,
      mergedViewport: { x: 0, y: 0, cols: localCols, rows: viewRows + CORNER_ROWS },
      statusBar,
    };
  }
  const viewRows = Math.max(0, localRows - 1);
  const viewport: Rect = { x: 0, y: 0, cols: localCols, rows: viewRows };
  return {
    local: { cols: localCols, rows: localRows },
    logical,
    mode: "narrow",
    viewport,
    cornerViewport: null,
    logPanel: null,
    mergedViewport: viewport,
    statusBar,
  };
}

function followAxis(
  cursor: number,
  view: number,
  logical: number,
  previous: number | undefined,
): number {
  const maxStart = Math.max(0, logical - view);
  if (view >= logical) return 0;
  let start = previous === undefined ? clamp(cursor - Math.floor(view / 2), 0, maxStart) : previous;
  const margin = view >= 8 ? 2 : 0;
  if (cursor < start + margin) {
    start = cursor - margin;
  } else if (cursor > start + view - 1 - margin) {
    start = cursor - view + 1 + margin;
  }
  return clamp(start, 0, maxStart);
}

/** Compute the camera / letterbox offsets for the current cursor. */
export function computeCamera(
  logical: TerminalSize,
  viewport: Rect,
  cursor: LogicalPoint,
  previous?: ViewportCamera,
): ViewportCamera {
  const logicalCols = clampDimension(logical.cols);
  const logicalRows = clampDimension(logical.rows);
  const fitsX = viewport.cols >= logicalCols;
  const fitsY = viewport.rows >= logicalRows;
  const offsetX = fitsX ? Math.floor((viewport.cols - logicalCols) / 2) : 0;
  const offsetY = fitsY ? Math.floor((viewport.rows - logicalRows) / 2) : 0;
  const x = fitsX
    ? 0
    : followAxis(
        clamp(Math.floor(cursor.x), 0, Math.max(0, logicalCols - 1)),
        viewport.cols,
        logicalCols,
        previous?.fitsX === false ? previous.x : undefined,
      );
  const y = fitsY
    ? 0
    : followAxis(
        clamp(Math.floor(cursor.y), 0, Math.max(0, logicalRows - 1)),
        viewport.rows,
        logicalRows,
        previous?.fitsY === false ? previous.y : undefined,
      );
  return { x, y, offsetX, offsetY, fitsX, fitsY };
}

/** The logical region currently visible in the merged viewport. */
export function visibleLogicalRect(
  logical: TerminalSize,
  viewport: Rect,
  camera: ViewportCamera,
): Rect {
  return {
    x: camera.x,
    y: camera.y,
    cols: Math.min(camera.fitsX ? logical.cols : viewport.cols, logical.cols),
    rows: Math.min(camera.fitsY ? logical.rows : viewport.rows, logical.rows),
  };
}

function insideRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.cols && y >= rect.y && y < rect.y + rect.rows;
}

/** Map a 0-based local screen cell to the logical grid, or null outside it. */
export function mapLocalToLogical(
  frame: ViewportFrame,
  camera: ViewportCamera,
  localX: number,
  localY: number,
): LogicalPoint | null {
  const inTop = insideRect(frame.viewport, localX, localY);
  const inCorner =
    frame.cornerViewport !== null && insideRect(frame.cornerViewport, localX, localY);
  if (!inTop && !inCorner) return null;
  const x = localX - frame.mergedViewport.x - camera.offsetX + camera.x;
  const y = localY - frame.mergedViewport.y - camera.offsetY + camera.y;
  if (x < 0 || y < 0 || x >= frame.logical.cols || y >= frame.logical.rows) return null;
  return { x, y };
}

/** Map a logical cell to the local screen, or null when it is off-camera. */
export function mapLogicalToLocal(
  frame: ViewportFrame,
  camera: ViewportCamera,
  logicalX: number,
  logicalY: number,
): LogicalPoint | null {
  const merged = frame.mergedViewport;
  const x = merged.x + camera.offsetX + logicalX - camera.x;
  const y = merged.y + camera.offsetY + logicalY - camera.y;
  const inTop = insideRect(frame.viewport, x, y);
  const inCorner = frame.cornerViewport !== null && insideRect(frame.cornerViewport, x, y);
  if (!inTop && !inCorner) return null;
  return { x, y };
}
