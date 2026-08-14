/**
 * Counting semaphore for per-route request caps. Acquire waits when no permit
 * is free; an abort signal rejects the waiter and removes it from the queue so
 * an aborted request never occupies a slot.
 * @module dsh-llm-pi-ai/semaphore
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Counting semaphore: at most `count` acquisitions hold concurrently, the rest queue in arrival order. */
export class Semaphore {
  private readonly queue: Array<() => void> = []

  constructor(private count: number) {
  }

  /**
   * Take one permit, waiting in arrival order when none is free.
   * @param signal - when provided, an abort rejects the wait and the waiter leaves the queue.
   * @returns a release closure; calling it more than once is a no-op.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.count > 0) {
      this.count -= 1
      return this.makeRelease()
    }
    await new Promise<void>((resolve, reject) => {
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        reject(new LlmError('pi-ai request aborted while queued for a slot', 'ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
    })
    return this.makeRelease()
  }

  /** One release closure per acquisition; repeated calls do nothing. */
  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next !== undefined) next()
      else this.count += 1
    }
  }
}
