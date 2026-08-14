/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-repo-map`.
 * @module @deepseek-ai/dsh-tool-repo-map/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-repo-map'

/** Cordis companion plugin name. */
export const name = 'tool-repo-map-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the tool is a read-only workspace scan that mounts no
// service, emits no durable events, and owns no mutable relation; the tool
// registry and execution pipeline carry their own package invariants.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
