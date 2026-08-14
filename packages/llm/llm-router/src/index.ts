/**
 * Declarative role-to-route routing on the agent request waterfall. One rules
 * block replaces scattered per-tool `agentOptions`: each rule names a
 * delegation-depth band (and optionally whether the agent inherits parent
 * history) plus the provider/model that band routes to. Rules are ordered; the
 * first match wins.
 *
 * ```yaml
 * - id: llm-router
 *   name: '@deepseek-ai/dsh-llm-router'
 *   config:
 *     rules:
 *       - maxDepth: 0                  # top-level loop
 *         provider: deepseek-official
 *         model: deepseek-v4-pro
 *       - minDepth: 1                  # fresh delegated children
 *         inheritsContext: false
 *         provider: muse-glimmer
 *         model: muse-glimmer
 *       - minDepth: 1                  # fork children (inherit parent history)
 *         inheritsContext: true
 *         provider: deepseek-official
 *         model: deepseek-v4-pro
 * ```
 *
 * @module @deepseek-ai/dsh-llm-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'llm-router'
export const inject = ['agents']

/** One ordered routing rule. */
export interface RouteRule {
  /** Inclusive delegation-depth floor; defaults to 0. */
  minDepth?: number
  /** Inclusive delegation-depth ceiling; omit for unbounded. */
  maxDepth?: number
  /**
   * Match only fork-style children (inherit parent history) when true, only
   * fresh children when false; omit for either.
   */
  inheritsContext?: boolean
  /** Provider route for matching agents. */
  provider: string
  /** Model id for matching agents. */
  model: string
}

/** Plugin configuration: the ordered routing rules this instance owns. */
export interface Config {
  /**
   * Ordered routing rules evaluated first-match; an empty or omitted set is
   * the dormant posture (nothing routes until a deployment supplies rules).
   */
  rules: RouteRule[]
}

const ruleSchema = z.object({
  minDepth: z.natural(),
  maxDepth: z.natural(),
  inheritsContext: z.boolean(),
  provider: z.string().required(),
  model: z.string().required(),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  rules: z.array(ruleSchema).default([]),
})

/** Validated immutable rule with defaults resolved. */
interface ResolvedRule {
  minDepth: number
  maxDepth: number | undefined
  inheritsContext: boolean | undefined
  provider: string
  model: string
}

function resolveRules(rules: readonly RouteRule[] | undefined): ResolvedRule[] {
  return (rules ?? []).map((entry) => {
    if (entry.provider.length === 0) throw new Error('llm-router: rule provider must be non-empty')
    if (entry.model.length === 0) throw new Error('llm-router: rule model must be non-empty')
    const minDepth = entry.minDepth ?? 0
    if (entry.maxDepth !== undefined && entry.maxDepth < minDepth) {
      throw new Error(`llm-router: rule maxDepth ${entry.maxDepth} must be >= minDepth ${minDepth}`)
    }
    return {
      minDepth,
      maxDepth: entry.maxDepth,
      inheritsContext: entry.inheritsContext,
      provider: entry.provider,
      model: entry.model,
    }
  })
}

/**
 * Install role-to-route rewriting. An empty rule set is the dormant posture:
 * nothing registers until configuration supplies rules.
 * @param ctx - plugin context that owns the listener.
 * @param config - validated routing rules.
 */
export function apply(ctx: Context, config: Config): void {
  const rules = resolveRules(config.rules)
  if (rules.length === 0) return
  const lifetime = new AbortController()

  const disposeListener = ctx.on('agent/request', (
    payload,
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    if (lifetime.signal.aborted) return next()
    const depth = payload.agent.session.header.delegationDepth ?? 0
    const inheritsContext = (payload.agent.session.header.seedLength ?? 0) > 0
    const rule = rules.find(entry =>
      depth >= entry.minDepth
      && (entry.maxDepth === undefined || depth <= entry.maxDepth)
      && (entry.inheritsContext === undefined || entry.inheritsContext === inheritsContext),
    )
    if (rule === undefined) return next()
    return (async () => {
      const config = await next()
      if (config.provider === rule.provider && config.model === rule.model) return config
      // Drop the route-specific reasoning effort; keep model-agnostic caps.
      return {
        provider: rule.provider,
        model: rule.model,
        ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
        ...config.temperature === undefined ? {} : { temperature: config.temperature },
        ...config.stop === undefined ? {} : { stop: config.stop },
      }
    })()
  })

  ctx.effect(() => () => {
    disposeListener()
    lifetime.abort(new Error('llm-router plugin disposed'))
  }, 'llm-router: dispose listener')
}
