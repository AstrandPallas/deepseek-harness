# ui-local-model

[English](README.md) | 中文

会话头部开关，通过 `/local-model` 命令通道停止和启动本地模型服务器。停止路径用于释放 GPU（玩游戏）；启动路径用于重新加载。

## Model Experience

开关通过 `command.execute` 提交 `/local-model stop|start`；运行/停止状态是一个共享快照存储，因此每个会话的头部都保持一致。命令在宿主端运行（由 `@deepseek-ai/dsh-command-local-model` 拥有），只追加标准的 `command/run`/`command/done` 生命周期对——不触及任何模型上下文或会话历史。

## Known Limitations and Deferred Work

初始状态假定模型正在运行，挂载时不会探测 `/local-model status`，因此带外停止的模型在下一次点击前会显示为运行中。
