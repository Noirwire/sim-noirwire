/** The value at fraction `p` of samples sorted ascending, or 0 when there are none. */
export const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
