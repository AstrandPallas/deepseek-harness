/**
 * Session-plane cost ledger. Prices (USD per 1M tokens, per provider route
 * and model) resolve from the hot-reloaded `cost-meter` settings section; the
 * fold reads only the durable `assistant/message` usage events already in the
 * session log, so cost is replay-exact and adds no durable state of its own.
 * A read-only `cost` tool reports the session total, and an optional
 * `budgetUsd` ceiling rejects further requests once a session exceeds it.
 *
 * @module @deepseek-ai/dsh-cost-meter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'cost-meter'
export const inject = ['tools']

const NS = settingsNamespace('cost-meter')

/** USD per 1M tokens. Omitted fields price at zero. */
export interface PriceRate {
  /** Input (prompt) tokens. */
  input?: number
  /** Output (completion) tokens. */
  output?: number
  /** Cache-read tokens. */
  cacheRead?: number
  /** Cache-write tokens. */
  cacheWrite?: number
}

/** Plugin configuration: per-route pricing and the optional session ceiling. */
export interface Config {
  /** Provider route → model id → USD per 1M token rates. Unlisted routes cost zero. */
  prices?: Record<string, Record<string, PriceRate>>
  /** USD ceiling per session; requests beyond it fail loudly. Omission disables the ceiling. */
  budgetUsd?: number
}

const priceRate = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  prices: z.dict(z.dict(priceRate)),
  budgetUsd: z.number().min(0),
})

/** Prices with every rate defaulted, keyed provider then model. */
type ResolvedPrices = ReadonlyMap<string, ReadonlyMap<string, Required<PriceRate>>>

interface ResolvedConfig {
  prices: ResolvedPrices
  budgetUsd: number | undefined
}

/** One session's fold over the durable usage events. */
export interface CostBreakdown {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** USD across priced routes at the configured rates. */
  costUsd: number
}

const ZERO_RATE: Required<PriceRate> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function resolveConfig(config: Config): ResolvedConfig {
  const prices = new Map<string, Map<string, Required<PriceRate>>>()
  for (const [provider, models] of Object.entries(config.prices ?? {})) {
    const byModel = new Map<string, Required<PriceRate>>()
    for (const [model, rate] of Object.entries(models)) {
      byModel.set(model, {
        input: rate.input ?? 0,
        output: rate.output ?? 0,
        cacheRead: rate.cacheRead ?? 0,
        cacheWrite: rate.cacheWrite ?? 0,
      })
    }
    prices.set(provider, byModel)
  }
  return { prices, budgetUsd: config.budgetUsd }
}

/**
 * Fold one session's durable model-usage events into token and USD totals.
 * Derived state only: the same log replayed under the same prices yields the
 * same fold, so nothing here needs its own durable event.
 * @param session - the session whose usage is priced.
 * @param prices - resolved per-route rates.
 */
function sessionCost(session: Session, prices: ResolvedPrices): CostBreakdown {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costUsd = 0
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const { usage, message } = event.data
    if (usage === undefined) continue
    if (message.source.kind !== 'model') continue
    const rate = prices.get(message.source.provider)?.get(message.source.model) ?? ZERO_RATE
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    cacheReadTokens += cacheRead
    cacheWriteTokens += cacheWrite
    costUsd += (
      usage.inputTokens * rate.input
      + usage.outputTokens * rate.output
      + cacheRead * rate.cacheRead
      + cacheWrite * rate.cacheWrite
    ) / 1e6
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }
}

function renderCost(breakdown: CostBreakdown): string {
  return [
    `Session cost: $${breakdown.costUsd.toFixed(4)}`,
    `Tokens: ${breakdown.inputTokens} input, ${breakdown.outputTokens} output, `
      + `${breakdown.cacheReadTokens} cache-read, ${breakdown.cacheWriteTokens} cache-write`,
  ].join('\n')
}

/**
 * Install the cost tool, the optional per-session budget guard, and the
 * settings section carrying the prices.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated prices and budget ceiling.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ResolvedConfig | undefined
  const resolved = (): ResolvedConfig => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    memoized = resolveConfig(raw)
    lastRaw = raw
    return memoized
  }
  resolved()

  ctx.tools.register(defineTool({
    name: 'cost',
    description: 'Report this session\'s accumulated token usage and estimated USD cost (priced routes only, per the configured rates).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // Read-only fold over the durable log: overlapping executions are safe.
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('cost tool requires a calling agent')
      return renderCost(sessionCost(session, resolved().prices))
    },
  }))

  const disposeBudget = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const budget = resolved().budgetUsd
    if (budget === undefined) return config
    const cost = sessionCost(payload.agent.session, resolved().prices).costUsd
    if (cost > budget) {
      throw new Error(`cost-meter: session cost $${cost.toFixed(4)} already exceeds the $${budget.toFixed(2)} budget`)
    }
    return config
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      resolved()
    },
  })

  ctx.effect(() => () => {
    disposeBudget()
  }, 'cost-meter: dispose budget listener')
}
