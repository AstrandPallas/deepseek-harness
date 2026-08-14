import type { LlmFailure } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one cross-provider failover scheduled after a terminal request failure. */
    'llm/fallback': LlmFallbackEventData
  }
}

/** Durable payload recorded before one cross-provider failover retry or cooldown preemption. */
export interface LlmFallbackEventData {
  turn: number
  step: number
  /** Provider route that served the failed (or preempted) request. */
  provider: string
  /** Provider route the retry fails over to. */
  toProvider: string
  /** Model id the retry fails over to. */
  toModel: string
  /** The terminal failure that scheduled the failover; absent when a cooldown preempted the request before it was sent. */
  failure?: LlmFailure
  /** True when the route was rewritten before dispatch because the source provider was still in cooldown. */
  preempted?: boolean
}
