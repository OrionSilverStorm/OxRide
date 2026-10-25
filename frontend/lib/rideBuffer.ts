// GPS points waiting to be sent to the ride log (Tiger Data). Pure, unit tested.
// Each batch starts with the last point already sent, so the server can work out the
// speed of the first new point too (backend ridelog.measure).

import type { RidePoint } from "./api";

export class PointBuffer {
  private waiting: RidePoint[] = [];
  private lastSent: RidePoint | null = null;
  private beforeBatch: RidePoint | null = null; // lastSent before the batch now in flight

  /** Add a GPS reading. Readings closer than 1 s to the previous one are skipped. */
  push(p: RidePoint): void {
    const prev = this.waiting.at(-1) ?? this.lastSent;
    if (prev && p.t - prev.t < 1000) return;
    this.waiting.push(p);
  }

  /** Points to send now (previous last point first), or null if there's nothing to send yet. */
  takeBatch(): RidePoint[] | null {
    const batch = this.lastSent ? [this.lastSent, ...this.waiting] : [...this.waiting];
    if (batch.length < 2) return null; // one point gives no speed: wait for another
    this.beforeBatch = this.lastSent;
    this.lastSent = this.waiting.at(-1)!;
    this.waiting = [];
    return batch;
  }

  /** The batch couldn't be sent: keep its new points for the next try. */
  giveBack(batch: RidePoint[]): void {
    const fresh = this.beforeBatch ? batch.slice(1) : batch;
    this.waiting = [...fresh, ...this.waiting];
    this.lastSent = this.beforeBatch;
    this.beforeBatch = null;
  }

  reset(): void {
    this.waiting = [];
    this.lastSent = null;
    this.beforeBatch = null;
  }
}
