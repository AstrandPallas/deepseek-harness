/**
 * Package-owned durable invariant for usage-bearing model messages.
 * @module @deepseek-ai/dsh-cost-meter/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-cost-meter'

/** Cordis companion plugin name. */
export const name = 'cost-meter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one usage-bearing model message at the durable boundary. */
function validateUsageMessage(event: SessionEvent<'assistant/message'>, fail: InvariantFailure): void {
  const { usage, message } = event.data
  if (usage === undefined) return
  if (message.source.kind !== 'model') {
    fail('assistant/message usage must accompany a model-sourced message')
  }
  for (const [field, value] of [
    ['inputTokens', usage.inputTokens],
    ['outputTokens', usage.outputTokens],
    ['cacheReadTokens', usage.cacheReadTokens],
    ['cacheWriteTokens', usage.cacheWriteTokens],
    ['reasoningTokens', usage.reasoningTokens],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      fail(`assistant/message usage.${field} must be a finite non-negative number`)
    }
  }
}

/** Validate every usage-bearing model message already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type === 'assistant/message') validateUsageMessage(event, fail)
  }
}

/** Install validation for loaded and newly appended usage-bearing messages. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type === 'assistant/message') validateUsageMessage(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the cost-meter invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
