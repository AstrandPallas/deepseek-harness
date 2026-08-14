/**
 * Goal governor: keeps an agent's goal loop quiet while child agents are
 * working, but only after the loop has proven it is spinning idle. The plugin
 * stays out of the way by default; it engages governed mode when a goal's
 * rounds complete several turns in a row with no tool activity while the
 * session has live children, then pauses the goal, re-arms it briefly when a
 * child settlement notice arrives so the parent can process the report and
 * launch the next wave, and pauses again until the children are done.
 *
 * @module @deepseek-ai/dsh-goal-governor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'goal-governor'
export const inject = ['goals', 'sessions', 'agents']

/** Consecutive tool-free rounds before governed mode engages. */
export const DEFAULT_IDLE_ROUND_THRESHOLD = 3
/** Consecutive rounds with tool activity that end governed mode. */
export const DEFAULT_PRODUCTIVE_ROUND_THRESHOLD = 2

/** Plugin configuration: the two streak thresholds. */
export interface Config {
  /** Consecutive tool-free rounds before governed mode engages (default 3). */
  idleRoundThreshold?: number
  /** Consecutive rounds with tool activity that end governed mode (default 2). */
  productiveRoundThreshold?: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  idleRoundThreshold: z.number().step(1).min(1).default(DEFAULT_IDLE_ROUND_THRESHOLD),
  productiveRoundThreshold: z.number().step(1).min(1).default(DEFAULT_PRODUCTIVE_ROUND_THRESHOLD),
})

/** Per-session governor bookkeeping. */
interface GovernorState {
  mode: 'normal' | 'governed'
  idleStreak: number
  productiveStreak: number
  pendingSettlements: number
  toolsThisTurn: number
}

/** Whether a session is a child of the given parent by its durable markers. */
function isChildOf(session: Session, parentId: string): boolean {
  if (session.header.parentSession !== parentId) return false
  return session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0
}

/**
 * Install the governor. Nothing pauses until a goal's rounds earn it: the
 * streak counters reset on every productive turn, so a loop that does real
 * work is never interrupted.
 * @param ctx - plugin context carrying goals, sessions, and agents.
 * @param config - validated streak thresholds.
 */
export function apply(ctx: Context, config: Config): void {
  const idleThreshold = config.idleRoundThreshold ?? DEFAULT_IDLE_ROUND_THRESHOLD
  const productiveThreshold = config.productiveRoundThreshold ?? DEFAULT_PRODUCTIVE_ROUND_THRESHOLD
  const states = new Map<string, GovernorState>()

  const stateOf = (sessionId: string): GovernorState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {
        mode: 'normal',
        idleStreak: 0,
        productiveStreak: 0,
        pendingSettlements: 0,
        toolsThisTurn: 0,
      }
      states.set(sessionId, state)
    }
    return state
  }

  /** Live children of one parent, read synchronously from attached sessions. */
  const hasLiveChildren = (parentId: string): boolean =>
    ctx.sessions.list().some(candidate => isChildOf(candidate, parentId))

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const state = stateOf(session.id)
    if (event.type === 'tool/call') {
      state.toolsThisTurn += 1
      return
    }
    if (event.type !== 'turn/end') return

    const productive = state.toolsThisTurn > 0
    state.toolsThisTurn = 0
    const goal = ctx.goals.get(agent)
    if (goal === undefined || goal.phase !== 'active') {
      state.mode = 'normal'
      state.idleStreak = 0
      state.productiveStreak = 0
      return
    }

    if (state.mode === 'normal') {
      if (productive) {
        state.idleStreak = 0
        return
      }
      state.idleStreak += 1
      if (state.idleStreak >= idleThreshold && hasLiveChildren(session.id)) {
        ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
        state.mode = 'governed'
        state.idleStreak = 0
      }
      return
    }

    // Governed: a settlement-processing round just settled. Count it, then
    // re-evaluate whether the quiet period should continue.
    if (productive) {
      state.productiveStreak += 1
      state.pendingSettlements = Math.max(0, state.pendingSettlements - 1)
    } else {
      state.productiveStreak = 0
    }
    const goalNow = ctx.goals.get(agent)
    if (goalNow === undefined || goalNow.phase !== 'active') {
      state.mode = 'normal'
      state.productiveStreak = 0
      return
    }
    if (state.productiveStreak >= productiveThreshold) {
      state.mode = 'normal'
      state.productiveStreak = 0
      state.idleStreak = 0
      return
    }
    if (state.pendingSettlements > 0 || hasLiveChildren(session.id)) {
      if (goalNow.phase === 'active') ctx.goals.pause(agent, { id: goalNow.id, revision: goalNow.revision })
      return
    }
    state.mode = 'normal'
    state.productiveStreak = 0
    state.idleStreak = 0
  })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source?.kind !== 'subagent-settled') return
    const state = stateOf(agent.session.id)
    state.pendingSettlements += 1
    if (state.mode !== 'governed') return
    const goal = ctx.goals.get(agent)
    if (goal === undefined || goal.phase !== 'paused') return
    ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
  })
}
