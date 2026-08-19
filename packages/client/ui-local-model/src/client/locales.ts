/** `local-model` namespace dictionaries (the header toggle's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.label': '本地模型',
  'button.running.aria': '本地模型运行中，按下停止',
  'button.running.title': '本地模型运行中 — 点击停止以释放显存',
  'button.stopped.aria': '本地模型已停止，按下启动',
  'button.stopped.title': '本地模型已停止 — 点击启动',
} satisfies Record<string, string>

/** The local-model namespace key union. */
export type LocalModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'button.label': 'Local model',
  'button.running.aria': 'Local model running, press to stop',
  'button.running.title': 'Local model running — click to stop and free the GPU',
  'button.stopped.aria': 'Local model stopped, press to start',
  'button.stopped.title': 'Local model stopped — click to start',
} satisfies Record<LocalModelKey, string>
