/**
 * Keyboard navigation for a horizontal ARIA tablist.
 *
 * Returns the next tab index for ArrowLeft/ArrowRight/Home/End, or undefined
 * for keys the tablist should ignore. Kept DOM-free so it is unit-testable.
 */
export function nextTabIndex(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "ArrowRight":
      return (current + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
