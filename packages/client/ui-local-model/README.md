# ui-local-model

English | [中文](README.zh.md)

Session-header toggle that stops and starts the local model server over the `/local-model` command channel. The stop path exists so a user can free the GPU (for gaming); the start path reloads it.

## Model Experience

The toggle submits `/local-model stop|start` through `command.execute`; the running/stopped fact is a shared snapshot store, so every session's header agrees. The command runs host-side (owned by `@deepseek-ai/dsh-command-local-model`) and appends only the standard `command/run`/`command/done` lifecycle pair — no model context or session history is touched.

## Known Limitations and Deferred Work

The initial state assumes the model is running and does not probe `/local-model status` on mount, so a model stopped out-of-band reads as running until the next click.
