import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as router from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(
  adapter: ScriptedAdapter,
  rules: router.RouteRule[] = [],
): Promise<{ ctx: Context; routerFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const routerFiber = await ctx.plugin(Object.assign((inner: Context) => {
    router.apply(inner, { rules })
  }, { inject: router.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['cloud', 'local', 'wrong'], adapter)
  return { ctx, routerFiber }
}

async function createAgent(
  ctx: Context,
  sessionId: string,
  agentOptions: AgentOptions,
  meta?: { delegationDepth?: number; seedLength?: number },
): Promise<Agent> {
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(sessionId),
    agentOptions,
    ...meta === undefined ? {} : { meta },
  })
  return handle.agent
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('role-to-route routing', () => {
  it('routes a depth-0 agent by the top-level rule', async () => {
    const adapter = new ScriptedAdapter()
    ;({ ctx: context } = await harness(adapter, [
      { maxDepth: 0, provider: 'cloud', model: 'cloud' },
    ]))
    const agent = await createAgent(context, 'r-depth0', { provider: 'wrong', model: 'wrong' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['cloud', 'cloud'],
    ])
  })

  it('routes a fresh depth-1 child to the local route', async () => {
    const adapter = new ScriptedAdapter()
    ;({ ctx: context } = await harness(adapter, [
      { maxDepth: 0, provider: 'cloud', model: 'cloud' },
      { minDepth: 1, inheritsContext: false, provider: 'local', model: 'local' },
    ]))
    const agent = await createAgent(
      context,
      'r-depth1-fresh',
      { provider: 'cloud', model: 'cloud' },
      { delegationDepth: 1 },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['local', 'local'],
    ])
  })

  it('routes a fork child (inherits history) to the cloud route', async () => {
    const adapter = new ScriptedAdapter()
    ;({ ctx: context } = await harness(adapter, [
      { maxDepth: 0, provider: 'cloud', model: 'cloud' },
      { minDepth: 1, inheritsContext: false, provider: 'local', model: 'local' },
      { minDepth: 1, inheritsContext: true, provider: 'cloud', model: 'cloud' },
    ]))
    const agent = await createAgent(
      context,
      'r-depth1-fork',
      { provider: 'local', model: 'local' },
      { delegationDepth: 1, seedLength: 1 },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['cloud', 'cloud'],
    ])
  })

  it('leaves an unmatched depth on its declared route', async () => {
    const adapter = new ScriptedAdapter()
    ;({ ctx: context } = await harness(adapter, [
      { maxDepth: 0, provider: 'cloud', model: 'cloud' },
    ]))
    const agent = await createAgent(
      context,
      'r-depth2',
      { provider: 'wrong', model: 'wrong' },
      { delegationDepth: 2 },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['wrong', 'wrong'],
    ])
  })

  it('stays dormant with no rules', async () => {
    const adapter = new ScriptedAdapter()
    ;({ ctx: context } = await harness(adapter, []))
    const agent = await createAgent(context, 'r-dormant', { provider: 'wrong', model: 'wrong' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['wrong', 'wrong'],
    ])
  })
})

describe('router config validation', () => {
  it('rejects an empty provider or model', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)

    for (const rule of [
      { provider: '', model: 'cloud' },
      { provider: 'cloud', model: '' },
    ]) {
      expect(() => router.apply(ctx, { rules: [rule] })).toThrow(/non-empty/)
    }
    await ctx.fiber.dispose()
  })

  it('rejects a maxDepth below minDepth', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)

    expect(() => router.apply(ctx, { rules: [{ minDepth: 2, maxDepth: 1, provider: 'cloud', model: 'cloud' }] }))
      .toThrow(/maxDepth/)
    await ctx.fiber.dispose()
  })
})
