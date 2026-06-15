/** Small numeric helpers shared by the sim, the client, and tooling. */

/** Smallest signed rotation from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Round to 2 decimal places (wire-size trim for positions/angles). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
