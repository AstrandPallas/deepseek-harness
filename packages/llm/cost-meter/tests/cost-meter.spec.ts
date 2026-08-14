import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as costMeter from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('cost-meter test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function pricedResponse(text: string, usage: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  config: costMeter.Config,
): Promise<{ ctx: Context; costFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const costFiber = await ctx.plugin(Object.assign((inner: Context) => {
    costMeter.apply(inner, config)
  }, { inject: costMeter.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['cloud'], adapter)
  return { ctx, costFiber }
}

function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

async function costReport(ctx: Context, agent: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('c-cost'),
    name: 'cost',
    arguments: {},
    agent,
  })
  const blocks = result.content.filter(block => block.type === 'text')
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('cost-meter', () => {
  it('reports the session cost folded from durable usage at configured rates', async () => {
    const adapter = new ScriptedAdapter([
      pricedResponse('first', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }),
      pricedResponse('second', { inputTokens: 200, outputTokens: 100 }),
    ])
    ;({ ctx: context } = await harness(adapter, {
      prices: {
        cloud: { 'cloud-model': { input: 1, output: 3, cacheRead: 0.2 } },
      },
    }))
    const agent = context.agentLoop.create(SessionId('cost-fold'), { provider: 'cloud', model: 'cloud-model' })
    followup(agent, 'first')
    await waitForIdle(agent)
    followup(agent, 'second')
    await waitForIdle(agent)

    // (1000*1 + 500*3 + 100*0.2)/1e6 = 0.00252; (200*1 + 100*3)/1e6 = 0.0005.
    expect(await costReport(context, agent)).toBe(
      'Session cost: $0.0030\nTokens: 1200 input, 600 output, 100 cache-read, 0 cache-write',
    )
  })

  it('prices unlisted routes at zero while tokens still accumulate', async () => {
    const adapter = new ScriptedAdapter([
      pricedResponse('unpriced', { inputTokens: 500, outputTokens: 50 }),
    ])
    ;({ ctx: context } = await harness(adapter, {}))
    const agent = context.agentLoop.create(SessionId('cost-zero'), { provider: 'cloud', model: 'cloud-model' })
    followup(agent, 'go')
    await waitForIdle(agent)

    expect(await costReport(context, agent)).toContain('$0.0000')
    expect(await costReport(context, agent)).toContain('500 input, 50 output')
  })

  it('rejects the next request once the session exceeds its budget', async () => {
    const adapter = new ScriptedAdapter([
      pricedResponse('expensive', { inputTokens: 1_000_000, outputTokens: 0 }),
      pricedResponse('blocked', { inputTokens: 1, outputTokens: 0 }),
    ])
    ;({ ctx: context } = await harness(adapter, {
      prices: { cloud: { 'cloud-model': { input: 1 } } },
      budgetUsd: 0.5,
    }))
    const agent = context.agentLoop.create(SessionId('cost-budget'), { provider: 'cloud', model: 'cloud-model' })
    followup(agent, 'expensive')
    await waitForIdle(agent)
    followup(agent, 'blocked')
    await waitForIdle(agent)

    // The second request never reaches the adapter: the guard failed it first.
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails the cost tool without a calling agent', async () => {
    const adapter = new ScriptedAdapter([pricedResponse('unused', { inputTokens: 1, outputTokens: 0 })])
    ;({ ctx: context } = await harness(adapter, {}))
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('c-no-agent'),
      name: 'cost',
      arguments: {},
      agent: undefined as never,
    })
    expect(result.isError).toBe(true)
    const text = result.content.filter(block => block.type === 'text').map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('requires a calling agent')
  })

  it('rejects negative rates and budgets at the schema boundary', () => {
    expect(() => costMeter.Config({ prices: { cloud: { m: { input: -1 } } } })).toThrow()
    expect(() => costMeter.Config({ budgetUsd: -1 })).toThrow()
  })
})

describe('ported from llm-use tests', () => {
  it('folds usage at per-million rates with the llm-use input+output formula', async () => {
    // llm-use computes cost = (tokens_in / 1e6) * cost_in + (tokens_out / 1e6) * cost_out
    // using the model's per-million-token rates. Its DEFAULT_MODELS price
    // claude-3-5-haiku at $0.25/M input and $1.25/M output.
    const adapter = new ScriptedAdapter([
      pricedResponse('one', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ])
    ;({ ctx: context } = await harness(adapter, {
      prices: {
        cloud: { 'cloud-model': { input: 0.25, output: 1.25 } },
      },
    }))
    const agent = context.agentLoop.create(SessionId('cost-llm-use'), { provider: 'cloud', model: 'cloud-model' })
    followup(agent, 'one')
    await waitForIdle(agent)

    // (1_000_000 * 0.25 + 1_000_000 * 1.25) / 1e6 = 1.50.
    expect(await costReport(context, agent)).toBe(
      'Session cost: $1.5000\nTokens: 1000000 input, 1000000 output, 0 cache-read, 0 cache-write',
    )
  })
})
