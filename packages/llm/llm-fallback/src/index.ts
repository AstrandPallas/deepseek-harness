/**
 * Cross-provider fallback on the agent loop's two request extension points.
 * Register it after `dsh-llm-retry` so same-route retries exhaust before a
 * route fails over. Each rule is directional: a terminal failure on `provider`
 * whose code is in `codes` retries on `toProvider`/`toModel`.
 *
 * The plugin also owns two LiteLLM-style guards against failover pathology:
 * a per-request-chain hop budget with tried-target deduplication (no A→B→A
 * ping-pong), and a per-provider cooldown that preempts further requests on a
 * source provider after a provider-level failure (`agent/request` rewrite),
 * so a dead or budget-exhausted route is not called again until it recovers.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from './types.ts'

export type { LlmFallbackEventData } from './types.ts'

export const name = 'llm-fallback'
export const inject = ['agents']

/** Failure codes that fail over by default: transient availability, overflow, and terminal quota. */
export const DEFAULT_FALLBACK_CODES = Object.freeze([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'CONTEXT_WINDOW_EXCEEDED',
  'QUOTA',
])

/**
 * Failure codes whose failover also puts the source provider into cooldown.
 * Provider- or account-level conditions (an outage, an exhausted balance), not
 * request-level ones: a context overflow is a property of one request, and the
 * next request must still reach the source provider.
 */
export const DEFAULT_COOLDOWN_CODES = Object.freeze([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'QUOTA',
])

/** Default cap on failover hops per request chain (one turn/step). */
export const DEFAULT_MAX_FALLBACKS = 3
/** Default duration a source provider stays in cooldown after a provider-level failover, in ms. */
export const DEFAULT_COOLDOWN_MS = 10_000

/** One directional failover rule. */
export interface FallbackRule {
  /** Source provider route whose terminal failures fail over. */
  provider: string
  /** Failover target provider route. */
  toProvider: string
  /** Failover target model id. */
  toModel: string
  /** Failure codes that trigger failover; defaults to {@link DEFAULT_FALLBACK_CODES}. */
  codes?: string[]
}

/** Plugin configuration: the directional failover rules and the failover-pathology guards this instance owns. */
export interface Config {
  /** Directional failover rules; an empty or omitted set is the dormant posture. */
  rules?: FallbackRule[]
  /** Cap on failover retries within one request chain; defaults to {@link DEFAULT_MAX_FALLBACKS}. */
  maxFallbacks?: number
  /**
   * Cooldown duration in ms after a failover whose code is in `cooldownCodes`;
   * 0 disables preemption. Defaults to {@link DEFAULT_COOLDOWN_MS}.
   */
  cooldownMs?: number
  /** Codes whose failover marks the source provider unhealthy; defaults to {@link DEFAULT_COOLDOWN_CODES}. */
  cooldownCodes?: string[]
}

const ruleSchema = z.object({
  provider: z.string().required(),
  toProvider: z.string().required(),
  toModel: z.string().required(),
  codes: z.array(z.string()),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  rules: z.array(ruleSchema).default([]),
  maxFallbacks: z.number().step(1).min(1),
  cooldownMs: z.number().step(1).min(0),
  cooldownCodes: z.array(z.string()),
})

/** Validated immutable rule with defaults resolved. */
interface ResolvedRule {
  provider: string
  toProvider: string
  toModel: string
  codes: readonly string[]
}

/** Validated config with every default resolved. */
interface ResolvedConfig {
  rules: ResolvedRule[]
  maxFallbacks: number
  cooldownMs: number
  cooldownCodes: ReadonlySet<string>
}

/**
 * Bound on attempt-chain retention. A live chain spans seconds at most, so a
 * minute of retention prunes every stale entry without capping a real chain.
 */
const ATTEMPT_TTL_MS = 60_000

/** Failover hops already consumed and targets already tried within one request chain. */
interface AttemptChain {
  hops: number
  targets: Set<string>
  at: number
}

function resolveConfig(config: Config): ResolvedConfig {
  const rules = (config.rules ?? []).map((entry) => {
    if (entry.provider.length === 0) throw new Error('llm-fallback: rule provider must be non-empty')
    if (entry.toProvider.length === 0) throw new Error('llm-fallback: rule toProvider must be non-empty')
    if (entry.toModel.length === 0) throw new Error('llm-fallback: rule toModel must be non-empty')
    if (entry.toProvider === entry.provider) throw new Error('llm-fallback: rule toProvider must differ from provider')
    return {
      provider: entry.provider,
      toProvider: entry.toProvider,
      toModel: entry.toModel,
      codes: entry.codes ?? DEFAULT_FALLBACK_CODES,
    }
  })
  return {
    rules,
    maxFallbacks: config.maxFallbacks ?? DEFAULT_MAX_FALLBACKS,
    cooldownMs: config.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    cooldownCodes: new Set(config.cooldownCodes ?? DEFAULT_COOLDOWN_CODES),
  }
}

/**
 * Install cross-provider fallback recovery plus cooldown preemption. An empty
 * rule set is the dormant posture: nothing registers until configuration
 * supplies rules.
 * @param ctx - plugin context that owns the listeners.
 * @param config - validated fallback rules and guard tunables.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (resolved.rules.length === 0) return
  const lifetime = new AbortController()

  // Provider -> epoch-ms until which the route is unhealthy and preempted.
  const cooldownUntil = new Map<string, number>()
  // `agentId:turn:step` -> hop budget and tried targets for that request chain.
  const attempts = new Map<string, AttemptChain>()

  const disposeError = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    const now = Date.now()
    for (const [key, chain] of attempts) {
      if (now - chain.at > ATTEMPT_TTL_MS) attempts.delete(key)
    }
    for (const rule of resolved.rules) {
      if (rule.provider !== payload.provider) continue
      if (!rule.codes.includes(payload.failure.code)) continue
      const key = `${payload.agent.id}:${payload.turn}:${payload.step}`
      const chain = attempts.get(key)
      if (chain !== undefined) {
        if (chain.hops >= resolved.maxFallbacks) continue
        if (chain.targets.has(rule.toProvider)) continue
        chain.hops += 1
        chain.targets.add(rule.toProvider)
        chain.at = now
      } else {
        // The source provider just failed too: never re-attempt it this chain.
        attempts.set(key, { hops: 1, targets: new Set([payload.provider, rule.toProvider]), at: now })
      }
      if (resolved.cooldownCodes.has(payload.failure.code)) {
        cooldownUntil.set(payload.provider, now + resolved.cooldownMs)
      }
      payload.agent.session.append('llm/fallback', {
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        toProvider: rule.toProvider,
        toModel: rule.toModel,
        failure: payload.failure,
      })
      return Promise.resolve({ kind: 'retry', provider: rule.toProvider, model: rule.toModel })
    }
    return next()
  })

  const disposeRequest = ctx.on('agent/request', async (
    payload,
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const config = await next()
    if (lifetime.signal.aborted) return config
    const provider = config.provider
    if (typeof provider !== 'string' || provider.length === 0) return config
    const until = cooldownUntil.get(provider)
    if (until === undefined || Date.now() >= until) return config
    // Preemption follows the first rule naming the cooled-down source. Do not
    // preempt into a target that is itself unhealthy: the attempt would fail
    // and only extend the chain.
    const rule = resolved.rules.find(entry => entry.provider === provider)
    if (rule === undefined) return config
    const targetUntil = cooldownUntil.get(rule.toProvider)
    if (targetUntil !== undefined && Date.now() < targetUntil) return config
    payload.agent.session.append('llm/fallback', {
      turn: payload.turn,
      step: payload.step,
      provider,
      toProvider: rule.toProvider,
      toModel: rule.toModel,
      preempted: true,
    })
    return { ...config, provider: rule.toProvider, model: rule.toModel }
  })

  ctx.effect(() => () => {
    disposeError()
    disposeRequest()
    lifetime.abort(new Error('llm-fallback plugin disposed'))
  }, 'llm-fallback: dispose listeners')
}
