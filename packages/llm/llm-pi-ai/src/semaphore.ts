/**
 * Counting semaphore for per-route request caps, with weighted acquisition
 * for shared KV-pool budgets. Acquire waits when not enough permits are free;
 * an abort signal rejects the waiter and removes it from the queue so an
 * aborted request never occupies a slot.
 *
 * Granting is first-fitting with head priority: a large blocked request does
 * not hold back smaller ones that fit, while requests of a class that fits
 * stay first-come first-served.
 * @module dsh-llm-pi-ai/semaphore
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Counting semaphore: at most `capacity` permits hold concurrently, the rest queue. */
export class Semaphore {
  private available: number
  private readonly queue: Array<{ units: number; entry: () => void }> = []

  constructor(private readonly capacity: number) {
    this.available = capacity
  }

  /**
   * Take one permit, waiting when none is free.
   * @param signal - when provided, an abort rejects the wait and the waiter leaves the queue.
   * @returns a release closure; calling it more than once is a no-op.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    return this.acquireUnits(1, signal)
  }

  /**
   * Take `units` permits, waiting until that many are free.
   * @param units - positive integer permit count.
   * @param signal - when provided, an abort rejects the wait and the waiter leaves the queue.
   * @returns a release closure; calling it more than once is a no-op.
   */
  async acquireUnits(units: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isInteger(units) || units <= 0) {
      throw new Error('semaphore: units must be a positive integer')
    }
    if (units > this.capacity) {
      throw new Error(`semaphore: requested units ${units} exceed capacity ${this.capacity}`)
    }
    const head = this.queue[0]
    // Skip-blocked: grant directly when this request fits and the oldest
    // waiter cannot be granted anyway. When the head fits, queue and let
    // drain() preserve its FIFO place.
    if (this.available >= units && (head === undefined || head.units > this.available)) {
      this.available -= units
      return this.makeRelease(units)
    }
    await new Promise<void>((resolve, reject) => {
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = this.queue.findIndex(waiter => waiter.entry === entry)
        if (index >= 0) this.queue.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        reject(new LlmError('pi-ai request aborted while queued for a slot', 'ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push({ units, entry })
    })
    // A fitting head must not wait for a future release: grant what fits now.
    this.drain()
    return this.makeRelease(units)
  }

  /** One release closure per acquisition; repeated calls do nothing. */
  private makeRelease(units: number): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.available += units
      this.drain()
    }
  }

  /** Grant every queued waiter that now fits, rescanning after each grant. */
  private drain(): void {
    let progressed = true
    while (progressed && this.queue.length > 0) {
      progressed = false
      for (let index = 0; index < this.queue.length; index++) {
        const waiter = this.queue[index]
        if (waiter === undefined || waiter.units > this.available) continue
        this.queue.splice(index, 1)
        this.available -= waiter.units
        waiter.entry()
        progressed = true
        break
      }
    }
  }
}
