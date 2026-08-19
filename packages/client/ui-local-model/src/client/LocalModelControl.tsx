import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalModelInjected } from './index.ts'
import css from './LocalModelControl.module.css'

/** Full header-toggle props: the runtime share (sessionId), locale seat, and injected toggle face. */
export type LocalModelControlProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'local-model'>
  & InjectFace<LocalModelInjected>

/**
 * Stop/start capsule for the Session Header. Reads the shared running fact and
 * toggles it through /local-model stop|start; failures surface as a status
 * line (English, per the error-surface policy).
 */
export function LocalModelControl({ sessionId, useLocalModel, toggle, t }: LocalModelControlProps) {
  const running = useLocalModel(state => state.running)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const onClick = (): void => {
    setBusy(true)
    setError(null)
    void toggle(sessionId).then((failure) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.toggle}
        disabled={busy}
        aria-busy={busy}
        aria-label={running ? t('button.running.aria') : t('button.stopped.aria')}
        title={running ? t('button.running.title') : t('button.stopped.title')}
        onClick={onClick}
      >
        <span className={css.dot} data-running={running} aria-hidden />
        <span>{t('button.label')}</span>
      </button>
      {error !== null && <span className={css.error} role="status" title={error}>failed to control local model</span>}
    </span>
  )
}
