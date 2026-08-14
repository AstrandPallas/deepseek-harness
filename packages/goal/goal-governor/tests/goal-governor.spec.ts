import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import * as governor from '../src/index.ts'

interface GoalDouble {
  phase: 'active' | 'paused' | 'complete'
  pauses: number
  resumes: number
}

function goalDouble(): GoalDouble {
  return { phase: 'active', pauses: 0, resumes: 0 }
}

async function harness(config: governor.Config = {}): Promise<{
  ctx: Context
  goal: GoalDouble
  fiber: Fiber
  agent: Agent
  session: Session
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const goal = goalDouble()
  ctx.provide('goals', {
    get: () => (goal.phase === 'complete'
      ? undefined
      : { phase: goal.phase, ref: { id: 'goal-1', revision: 1 }, activation: 'armed' }),
    pause: () => {
      goal.pauses += 1
      goal.phase = 'paused'
    },
    resume: () => {
      goal.resumes += 1
      goal.phase = 'active'
    },
  } as never)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    governor.apply(inner, config)
  }, { inject: governor.inject }))
  const session = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/work' } })
  const agent = { id: session.id, session, status: 'idle' } as Agent
  ctx.agents.register(agent)
  return { ctx, goal, fiber, agent, session }
}

/** Attach one live child session to the parent, the durable markers included. */
function attachChild(ctx: Context, parent: Session, id: string): void {
  ctx.sessions.create(SessionId(id), {
    meta: { cwd: '/work', parentSession: parent.id, origin: 'subagent' },
  })
}

let turn = 0
function idleTurn(session: Session): void {
  turn += 1
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function productiveTurn(session: Session): void {
  turn += 1
  session.append('turn/start', { turn })
  session.append('tool/call', { turn, step: 1, callId: CallId(`c${turn}`), name: 'read', arguments: '{}' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function settle(childId: string, ctx: Context, agent: Agent): void {
  const message = {
    id: childId,
    source: { kind: 'subagent-settled' },
    content: [],
  } as unknown as UserMessage
  ctx.emit('agent/inbox/inserted', { agent, message })
}

let contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
  turn = 0
})

describe('goal-governor', () => {
  it('stays out of the way while rounds are productive', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    attachChild(h.ctx, h.session, 'child')
    for (let i = 0; i < 6; i++) productiveTurn(h.session)

    expect(h.goal.pauses).toBe(0)
  })

  it('does not engage on idle rounds without live children', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    for (let i = 0; i < 5; i++) idleTurn(h.session)

    expect(h.goal.pauses).toBe(0)
  })

  it('pauses after idle rounds while children are live', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    attachChild(h.ctx, h.session, 'child')
    for (let i = 0; i < 3; i++) idleTurn(h.session)

    expect(h.goal.pauses).toBe(1)
    expect(h.goal.phase).toBe('paused')
  })

  it('re-arms on a settlement notice and re-pauses after the processing round', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    attachChild(h.ctx, h.session, 'child')
    for (let i = 0; i < 3; i++) idleTurn(h.session)
    expect(h.goal.phase).toBe('paused')

    settle('child', h.ctx, h.agent)
    expect(h.goal.resumes).toBe(1)
    expect(h.goal.phase).toBe('active')

    productiveTurn(h.session)
    expect(h.goal.pauses).toBe(2)
    expect(h.goal.phase).toBe('paused')
  })

  it('leaves governed mode after sustained productive rounds', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    attachChild(h.ctx, h.session, 'child')
    for (let i = 0; i < 3; i++) idleTurn(h.session)
    expect(h.goal.phase).toBe('paused')

    settle('child', h.ctx, h.agent)
    productiveTurn(h.session)
    settle('child', h.ctx, h.agent)
    productiveTurn(h.session)
    expect(h.goal.pauses).toBe(2)

    // Back to normal: another idle round no longer pauses.
    idleTurn(h.session)
    expect(h.goal.pauses).toBe(2)
  })

  it('steps aside once the goal completes', async () => {
    const h = await harness()
    contexts.push(h.ctx)
    attachChild(h.ctx, h.session, 'child')
    for (let i = 0; i < 3; i++) idleTurn(h.session)
    expect(h.goal.phase).toBe('paused')

    ;(h.goal.phase as 'complete') = 'complete'
    productiveTurn(h.session)
    expect(h.goal.pauses).toBe(1)
  })
})
