import { describe, expect, it } from 'vitest'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { Semaphore } from '../src/semaphore.ts'

describe('Semaphore', () => {
  it('hands permits up to the cap and queues the rest in arrival order', async () => {
    const sem = new Semaphore(2)
    const first = await sem.acquire()
    const second = await sem.acquire()
    let thirdAcquired = false
    const third = sem.acquire().then((release) => {
      thirdAcquired = true
      return release
    })
    // The third acquisition queues: no permit was handed to it yet.
    await Promise.resolve()
    expect(thirdAcquired).toBe(false)
    first()
    await third
    expect(thirdAcquired).toBe(true)
    second()
  })

  it('rejects a waiter whose signal aborts before a slot frees, without consuming the slot', async () => {
    const sem = new Semaphore(1)
    const releaseFirst = await sem.acquire()
    const controller = new AbortController()
    const waiting = sem.acquire(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow(/aborted/)
    // The released permit must not be lost to the removed waiter.
    releaseFirst()
    const releaseNext = await sem.acquire()
    releaseNext()
  })

  it('ignores a second call to the same release closure', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release()
    const releaseAgain = await sem.acquire()
    releaseAgain()
  })

  it('rejects a zero maxConcurrent profile at the schema boundary', () => {
    expect(() => LlmPiAi.Config({
      providers: {
        acme: {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm', contextWindow: 4096, maxTokens: 512 }],
          maxConcurrent: 0,
        },
      },
    })).toThrow()
  })

  it('rejects kvUnits without kvPool, or without a baseURL, at the resolve boundary', () => {
    const base = {
      api: 'openai-completions',
      models: [{ id: 'm', contextWindow: 4096, maxTokens: 512 }],
    }
    expect(() => resolveProfiles({
      acme: { ...base, baseURL: 'https://acme.test', kvUnits: 2 },
    })).toThrow(/together/)
    expect(() => resolveProfiles({
      acme: { ...base, kvUnits: 2, kvPool: 6 },
    })).toThrow(/baseURL/)
    expect(() => resolveProfiles({
      acme: { ...base, baseURL: 'https://acme.test', kvUnits: 8, kvPool: 6 },
    })).toThrow(/must not exceed/)
  })

  describe('weighted acquisition', () => {
    it('lets a small request skip a blocked large one', async () => {
      const sem = new Semaphore(6)
      const releaseLean1 = await sem.acquireUnits(2)
      let bigGranted = false
      const big = sem.acquireUnits(6).then((release) => {
        bigGranted = true
        return release
      })
      // The big waiter cannot fit (4 free < 6), so a new small request may pass it.
      const releaseLean2 = await sem.acquireUnits(2)
      expect(bigGranted).toBe(false)
      releaseLean1()
      releaseLean2()
      const releaseBig = await big
      expect(bigGranted).toBe(true)
      releaseBig()
    })

    it('serves fitting requests first-come first-served when the head fits', async () => {
      const sem = new Semaphore(2)
      const releaseFirst = await sem.acquire()
      const releaseSecond = await sem.acquire()
      const order: string[] = []
      const third = sem.acquire().then((release) => {
        order.push('third')
        return release
      })
      const fourth = sem.acquire().then((release) => {
        order.push('fourth')
        return release
      })
      await Promise.resolve()
      expect(order).toEqual([])
      releaseFirst()
      releaseSecond()
      await Promise.all([third, fourth])
      expect(order).toEqual(['third', 'fourth'])
    })

    it('rejects invalid unit requests and requests above capacity', async () => {
      const sem = new Semaphore(4)
      await expect(sem.acquireUnits(0)).rejects.toThrow(/positive integer/)
      await expect(sem.acquireUnits(1.5)).rejects.toThrow(/positive integer/)
      await expect(sem.acquireUnits(5)).rejects.toThrow(/exceed capacity/)
    })
  })
})

describe('ported from llm-use tests', () => {
  it('bounds a worker pool: every submitted task completes while in-flight never exceeds maxConcurrent', async () => {
    // llm-use `_spawn_workers` submits N subtasks through a pool bounded by
    // max_workers and returns exactly one result per subtask. The Semaphore is
    // the DSH equivalent cap: more tasks than permits all settle, and no more
    // than the cap hold a permit at once.
    const cap = 2
    const sem = new Semaphore(cap)
    let inFlight = 0
    let peak = 0
    const run = async (): Promise<void> => {
      const release = await sem.acquire()
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      release()
    }
    await Promise.all(Array.from({ length: 6 }, () => run()))
    expect(peak).toBe(cap)
    expect(inFlight).toBe(0)
  })
})
