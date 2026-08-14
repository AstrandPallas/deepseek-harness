/**
 * Package-owned durable invariant for goal-governor: the plugin writes nothing,
 * so its companion validates the relationship the governor itself relies on,
 * that a goal the loop reports active is recorded as active at the commit
 * point.
 * @module @deepseek-ai/dsh-goal-governor/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-goal-governor'

/** Cordis companion plugin name. */
export const name = 'goal-governor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one goal change at the durable boundary. */
function validateGoalChange(event: SessionEvent<'goal/change'>, fail: InvariantFailure): void {
  const change = event.data
  if (typeof change.operation !== 'string' || change.operation.length === 0) {
    fail('goal/change operation must be a non-empty string')
  }
  if (change.operation === 'clear') {
    if (typeof change.cleared?.revision !== 'number') {
      fail('goal/change clear must carry the cleared goal revision')
    }
    return
  }
  const goal = change.goal
  if (goal === undefined) {
    fail('goal/change must carry its goal snapshot')
  }
  if (typeof goal.phase !== 'string' || goal.phase.length === 0) {
    fail('goal/change goal.phase must be a non-empty string')
  }
}

/** Validate every goal change already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type === 'goal/change') validateGoalChange(event, fail)
  }
}

/** Install validation for loaded and newly appended goal changes. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type === 'goal/change') validateGoalChange(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the goal-governor invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
