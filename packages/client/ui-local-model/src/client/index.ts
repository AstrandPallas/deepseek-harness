/** Browser plugin owning the Session-header local-model stop/start toggle. */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocalModelControl } from './LocalModelControl.tsx'
import { en, zh, type LocalModelKey } from './locales.ts'

export type { LocalModelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The header toggle's copy. */
    'local-model': LocalModelKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'local-model'

/** The shared running/stopped fact this toggle reads and writes. */
interface LocalModelState {
  running: boolean
}

/** Injected business face of the header toggle. */
export interface LocalModelInjected {
  hooks: { localModel: ObservableSnapshot<LocalModelState> }
  /** Stop or start the model, returning null on admission or a failure line. */
  toggle: (sessionId: SessionId) => Promise<string | null>
}

/** Required services: the header slot registry, commands Remote, and locale registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/**
 * Register the header toggle over the /local-model command channel. The
 * running/stopped fact is a shared store so every session's header agrees.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-local-model: dictionaries')

  const store = createSnapshotStore<LocalModelState>({ running: true })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'local-model',
    locale: NS,
    inject: (): LocalModelInjected => ({
      hooks: { localModel: store },
      toggle: async (sessionId: SessionId) => {
        const running = store.getSnapshot().running
        const line = running ? '/local-model stop' : '/local-model start'
        const result = await ctx.remote.commands.execute(sessionId, line, [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return `unknown command: ${line}`
        store.update((state) => { state.running = !running })
        return null
      },
    }),
  }, LocalModelControl))
}
