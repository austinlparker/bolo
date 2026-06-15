/**
 * Typed-array binary (min) heap for A* pathfinding.
 *
 * Replaces the old `[number, number][]` tuple heap that allocated up to 20,000
 * small arrays per A* call. This version uses two parallel typed arrays
 * (Float64Array for f-scores, Int32Array for node IDs) pre-allocated once and
 * reused across all searches — zero per-push allocations.
 *
 * The heap is 1-indexed internally (index 0 is unused) to simplify parent/child
 * arithmetic: parent(i) = i >> 1, left(i) = i << 1, right(i) = (i << 1) + 1.
 */
export class TypedMinHeap {
  /** f-scores, 1-indexed */
  private fScores: Float64Array;
  /** node IDs (tile indices), 1-indexed */
  private nodeIds: Int32Array;
  /** Number of elements currently in the heap */
  private _size = 0;

  constructor(capacity: number) {
    // +1 because we use 1-based indexing
    this.fScores = new Float64Array(capacity + 1);
    this.nodeIds = new Int32Array(capacity + 1);
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this.fScores.length - 1;
  }

  /** Ensure we can hold at least `needed` elements. Grows if necessary. */
  ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let newCap = this.capacity;
    while (newCap < needed) newCap *= 2;
    const newF = new Float64Array(newCap + 1);
    const newIds = new Int32Array(newCap + 1);
    newF.set(this.fScores);
    newIds.set(this.nodeIds);
    this.fScores = newF;
    this.nodeIds = newIds;
  }

  clear(): void {
    this._size = 0;
  }

  isEmpty(): boolean {
    return this._size === 0;
  }

  /** Push (fScore, nodeId) onto the heap. */
  push(fScore: number, nodeId: number): void {
    this._size++;
    const fs = this.fScores;
    const ids = this.nodeIds;
    let i = this._size;
    fs[i] = fScore;
    ids[i] = nodeId;
    // sift up
    while (i > 1) {
      const parent = i >> 1;
      if (fs[parent] <= fs[i]) break;
      // swap
      const tf = fs[parent];
      fs[parent] = fs[i];
      fs[i] = tf;
      const tn = ids[parent];
      ids[parent] = ids[i];
      ids[i] = tn;
      i = parent;
    }
  }

  /** Pop the minimum-fScore entry. Returns {fScore, nodeId}. */
  pop(): { fScore: number; nodeId: number } {
    const fs = this.fScores;
    const ids = this.nodeIds;
    const topF = fs[1];
    const topId = ids[1];
    const lastF = fs[this._size];
    const lastId = ids[this._size];
    this._size--;
    if (this._size > 0) {
      fs[1] = lastF;
      ids[1] = lastId;
      // sift down
      let i = 1;
      for (;;) {
        const l = i << 1;
        const r = l + 1;
        let m = i;
        if (l <= this._size && fs[l] < fs[m]) m = l;
        if (r <= this._size && fs[r] < fs[m]) m = r;
        if (m === i) break;
        const tf = fs[m];
        fs[m] = fs[i];
        fs[i] = tf;
        const tn = ids[m];
        ids[m] = ids[i];
        ids[i] = tn;
        i = m;
      }
    }
    return { fScore: topF, nodeId: topId };
  }
}
