import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmFallbackEventData } from '../src/types.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk>

it('keeps the browser-safe fallback payload identical to the session event', () => {
  expectTypeOf<LlmFallbackEventData>().toEqualTypeOf<SessionEventMap['llm/fallback']>()
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('fallback test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  config: fallback.Config = {},
): Promise<{ ctx: Context; fallbackFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const fallbackFiber = await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['local', 'cloud', 'mid', 'far'], adapter)
  return { ctx, fallbackFiber }
}

function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('cross-provider fallback', () => {
  it('retries a terminal source failure once on the fallback route', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('local server down', 'SERVER'),
      textResponse('recovered on cloud'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-success'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
    ])
    const fallbackEvent = agent.session.events.find(event => event.type === 'llm/fallback')
    expect(fallbackEvent?.type).toBe('llm/fallback')
    if (fallbackEvent?.type === 'llm/fallback') {
      expect(fallbackEvent.data).toEqual({
        turn: 1,
        step: 1,
        provider: 'local',
        toProvider: 'cloud',
        toModel: 'cloud',
        failure: { message: 'local server down', code: 'SERVER' },
      })
    }
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered on cloud' }],
      source: { kind: 'model', provider: 'cloud', model: 'cloud' },
    })
  })

  it('stays dormant with no rules: the failure stays terminal', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('local server down', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, {}))
    const agent = context.agentLoop.create(SessionId('fallback-dormant'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })

  it('does not fail over a code outside the rule codes', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-code-filter'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })

  it('delegates to downstream recovery when no rule names the provider', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('local server down', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'other', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-provider-filter'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })

  it('honours an explicit codes override', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud', codes: ['AUTH'] },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-codes-override'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
    ])
  })

  it('fails over QUOTA and CONTEXT_WINDOW_EXCEEDED by default', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('insufficient balance', 'QUOTA'),
      textResponse('recovered'),
      new LlmError('context size has been exceeded', 'CONTEXT_WINDOW_EXCEEDED'),
      textResponse('recovered again'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      cooldownMs: 0,
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const quotaAgent = context.agentLoop.create(SessionId('fallback-default-quota'), {
      provider: 'local',
      model: 'local',
    })
    quotaAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(quotaAgent)
    const contextAgent = context.agentLoop.create(SessionId('fallback-default-context'), {
      provider: 'local',
      model: 'local',
    })
    contextAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(contextAgent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['local', 'local'],
      ['cloud', 'cloud'],
    ])
  })
})

describe('failover chain bounds', () => {
  it('caps failover hops at maxFallbacks and terminates the chain', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('down', 'SERVER'),
      new LlmError('down', 'SERVER'),
      new LlmError('down', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      maxFallbacks: 2,
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'mid', toModel: 'mid' },
        { provider: 'mid', toProvider: 'far', toModel: 'far' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-hop-cap'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['mid', 'mid'],
    ])
  })

  it('never re-attempts a route already tried in the chain (ping-pong protection)', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('down', 'SERVER'),
      new LlmError('down', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      maxFallbacks: 5,
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'local', toModel: 'local' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-ping-pong'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
    ])
  })
})

describe('cooldown preemption', () => {
  it('rewrites the next agent request past a cooled-down provider without calling it', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('local server down', 'SERVER'),
      textResponse('recovered on cloud'),
      textResponse('served by cloud'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const first = context.agentLoop.create(SessionId('fallback-cooldown-first'), {
      provider: 'local',
      model: 'local',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(first)
    const second = context.agentLoop.create(SessionId('fallback-cooldown-second'), {
      provider: 'local',
      model: 'local',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(second)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['cloud', 'cloud'],
    ])
    const fallbackEvents = second.session.events.filter(event => event.type === 'llm/fallback')
    expect(fallbackEvents).toHaveLength(1)
    const preempted = fallbackEvents[0]
    if (preempted?.type !== 'llm/fallback') throw new Error('expected an llm/fallback event')
    expect(preempted.data).toMatchObject({ provider: 'local', toProvider: 'cloud', toModel: 'cloud', preempted: true })
    expect(preempted.data.failure).toBeUndefined()
  })

  it('does not cooldown after a context overflow: a later agent still reaches the source', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('context size has been exceeded', 'CONTEXT_WINDOW_EXCEEDED'),
      textResponse('recovered on cloud'),
      textResponse('served locally'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud', codes: ['CONTEXT_WINDOW_EXCEEDED'] },
      ],
    }))
    const first = context.agentLoop.create(SessionId('fallback-context-first'), {
      provider: 'local',
      model: 'local',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(first)
    const second = context.agentLoop.create(SessionId('fallback-context-second'), {
      provider: 'local',
      model: 'local',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(second)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['local', 'local'],
    ])
    expect(second.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })
})

describe('fallback config validation', () => {
  it('rejects an empty provider, toProvider, or toModel, and a self-target rule', async () => {
    const adapter = new ScriptedAdapter([textResponse('unused')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.llm.registerAdapter(['local', 'cloud'], adapter)

    for (const [rule, pattern] of [
      [{ provider: '', toProvider: 'cloud', toModel: 'cloud' }, /non-empty/],
      [{ provider: 'local', toProvider: '', toModel: 'cloud' }, /non-empty/],
      [{ provider: 'local', toProvider: 'cloud', toModel: '' }, /non-empty/],
      [{ provider: 'local', toProvider: 'local', toModel: 'cloud' }, /differ/],
    ] as const) {
      expect(() => fallback.apply(ctx, { rules: [rule] })).toThrow(pattern)
    }
    await ctx.fiber.dispose()
  })

  it('rejects non-positive guard tunables at the schema boundary', () => {
    expect(() => fallback.Config({ rules: [], maxFallbacks: 0 })).toThrow()
    expect(() => fallback.Config({ rules: [], maxFallbacks: 1.5 })).toThrow()
    expect(() => fallback.Config({ rules: [], cooldownMs: -1 })).toThrow()
  })
})

// Each test below ports one distinct failover/cooldown semantic pinned by
// LiteLLM's router tests (tests/local_testing/test_router_fallbacks.py and
// friends), mapped onto this plugin's vocabulary. `deployment` -> provider
// route, `insufficient_quota` -> QUOTA code, `context_window_exceeded` ->
// CONTEXT_WINDOW_EXCEEDED code, and cooldown exclusion of unhealthy
// deployments -> our agent/request preemption rewrite.
describe('ported from litellm router tests', () => {
  it('walks a multi-hop fallback chain to the first route that succeeds', async () => {
    // test_multiple_fallbacks: fallback 1 fails, fallback 2 succeeds.
    const adapter = new ScriptedAdapter([
      new LlmError('local down', 'SERVER'),
      new LlmError('cloud down', 'SERVER'),
      textResponse('recovered on mid'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'mid', toModel: 'mid' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-chain-walk'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['mid', 'mid'],
    ])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'mid', model: 'mid' },
    })
  })

  it('honours maxFallbacks even when a later route would have succeeded', async () => {
    // run_async_fallback base case: `fallback_depth >= max_fallbacks` raises and stops.
    const adapter = new ScriptedAdapter([
      new LlmError('local down', 'SERVER'),
      new LlmError('cloud down', 'SERVER'),
      textResponse('never reached: mid is beyond the hop cap'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      maxFallbacks: 1,
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'mid', toModel: 'mid' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-depth-cap'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
    ])
  })

  it('never re-attempts a route already tried across a longer cycle', async () => {
    // run_async_fallback's `attempted` set skips a target already walked (no ping-pong).
    const adapter = new ScriptedAdapter([
      new LlmError('local down', 'SERVER'),
      new LlmError('cloud down', 'SERVER'),
      new LlmError('mid down', 'SERVER'),
      textResponse('never reached: mid would loop back to local'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      maxFallbacks: 5,
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'mid', toModel: 'mid' },
        { provider: 'mid', toProvider: 'local', toModel: 'local' },
      ],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-cycle-dedup'), {
      provider: 'local',
      model: 'local',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['mid', 'mid'],
    ])
  })

  it('fails over an insufficient_quota (QUOTA) failure and cools down the source provider', async () => {
    // QUOTA is a provider/account-level condition: it fails over AND preempts the source.
    const adapter = new ScriptedAdapter([
      new LlmError('insufficient balance', 'QUOTA'),
      textResponse('recovered on cloud'),
      textResponse('served by cloud'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const first = context.agentLoop.create(SessionId('fallback-quota-first'), {
      provider: 'local',
      model: 'local',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(first)
    const second = context.agentLoop.create(SessionId('fallback-quota-second'), {
      provider: 'local',
      model: 'local',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(second)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['cloud', 'cloud'],
    ])
    const preempted = second.session.events.find(event => event.type === 'llm/fallback')
    expect(preempted?.type).toBe('llm/fallback')
    if (preempted?.type === 'llm/fallback') {
      expect(preempted.data).toMatchObject({ provider: 'local', toProvider: 'cloud', preempted: true })
      expect(preempted.data.failure).toBeUndefined()
    }
  })

  it('fails over a context-window overflow by default without cooling down the source', async () => {
    // ContextWindowExceededError triggers fallback but is request-level, so no cooldown.
    const adapter = new ScriptedAdapter([
      new LlmError('context size has been exceeded', 'CONTEXT_WINDOW_EXCEEDED'),
      textResponse('recovered on cloud'),
      textResponse('served locally'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
      ],
    }))
    const first = context.agentLoop.create(SessionId('fallback-context-default-first'), {
      provider: 'local',
      model: 'local',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(first)
    const second = context.agentLoop.create(SessionId('fallback-context-default-second'), {
      provider: 'local',
      model: 'local',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(second)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['local', 'local'],
    ])
    expect(second.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })

  it('does not preempt a cooled-down source into a target that is itself unhealthy', async () => {
    // Cooldown excludes unhealthy deployments from selection: a doomed rewrite is skipped.
    const adapter = new ScriptedAdapter([
      new LlmError('local down', 'SERVER'),
      new LlmError('cloud down', 'SERVER'),
      textResponse('recovered on mid'),
      textResponse('served locally'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      rules: [
        { provider: 'local', toProvider: 'cloud', toModel: 'cloud' },
        { provider: 'cloud', toProvider: 'mid', toModel: 'mid' },
      ],
    }))
    const first = context.agentLoop.create(SessionId('fallback-unhealthy-target-first'), {
      provider: 'local',
      model: 'local',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(first)
    const second = context.agentLoop.create(SessionId('fallback-unhealthy-target-second'), {
      provider: 'local',
      model: 'local',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(second)

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
      ['cloud', 'cloud'],
      ['mid', 'mid'],
      ['local', 'local'],
    ])
    expect(second.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
  })
})
