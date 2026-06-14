/** Small numeric helpers shared by the sim, the client, and tooling. */

/** Smallest signed rotation from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Round to 2 decimal places (wire-size trim for positions/angles). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
