/**
 * Pure viewport geometry.
 *
 * The local terminal is split into a TUI viewport, an optional debug log panel,
 * and a one-line status bar. The logical TUI grid is fixed for the session; the
 * viewport either letterboxes it (when the local area is larger) or crops it
 * with a camera that follows the TUI cursor.
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

export interface ViewportFrame {
  readonly local: TerminalSize;
  readonly logical: TerminalSize;
  /** Requested log rows after clamping to leave at least one viewport row. */
  readonly logRows: number;
  readonly viewport: Rect;
  readonly logPanel: Rect | null;
  readonly statusBar: Rect;
}

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
 * Split the local terminal into viewport / log panel / status bar.
 *
 * `requestedLogRows` is clamped so the viewport keeps at least one row when the
 * terminal has room. The status bar always occupies the final row.
 */
export function computeViewportFrame(
  local: TerminalSize,
  logical: TerminalSize,
  requestedLogRows: number,
): ViewportFrame {
  const localCols = clampDimension(local.cols);
  const localRows = clampDimension(local.rows);
  const logRows = clamp(Math.floor(requestedLogRows), 0, Math.max(0, localRows - 2));
  const viewRows = Math.max(0, localRows - 1 - logRows);
  const viewport: Rect = { x: 0, y: 0, cols: localCols, rows: viewRows };
  const logPanel: Rect | null =
    logRows > 0 ? { x: 0, y: viewRows, cols: localCols, rows: logRows } : null;
  const statusBar: Rect =
    localRows > 0
      ? { x: 0, y: localRows - 1, cols: localCols, rows: 1 }
      : { x: 0, y: 0, cols: localCols, rows: 0 };
  return {
    local: { cols: localCols, rows: localRows },
    logical,
    logRows,
    viewport,
    logPanel,
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

/** The logical region currently visible in the viewport. */
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

/** Map a 0-based local screen cell to the logical grid, or null outside it. */
export function mapLocalToLogical(
  frame: ViewportFrame,
  camera: ViewportCamera,
  localX: number,
  localY: number,
): LogicalPoint | null {
  if (
    localX < frame.viewport.x ||
    localX >= frame.viewport.x + frame.viewport.cols ||
    localY < frame.viewport.y ||
    localY >= frame.viewport.y + frame.viewport.rows
  ) {
    return null;
  }
  const x = localX - frame.viewport.x - camera.offsetX + camera.x;
  const y = localY - frame.viewport.y - camera.offsetY + camera.y;
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
  const x = frame.viewport.x + camera.offsetX + logicalX - camera.x;
  const y = frame.viewport.y + camera.offsetY + logicalY - camera.y;
  if (
    x < frame.viewport.x ||
    x >= frame.viewport.x + frame.viewport.cols ||
    y < frame.viewport.y ||
    y >= frame.viewport.y + frame.viewport.rows
  ) {
    return null;
  }
  return { x, y };
}
