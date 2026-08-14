/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-router`.
 * @module @deepseek-ai/dsh-llm-router/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-router'

/** Cordis companion plugin name. */
export const name = 'llm-router-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the router rewrites the request route, and the only
// durable consequence is the request/header and request/context change the
// agent loop already logs — the routed provider/model is the logged provider/
// model, validated by dsh-agent-loop's own invariant. The router owns no
// separate durable relation to check.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
