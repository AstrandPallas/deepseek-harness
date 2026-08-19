# command-local-model

[English](README.md) | 中文

面向用户的 `/local-model` 斜杠命令，用于停止、启动或报告服务于本地 worker 池的本地模型服务器。停止路径用于释放 GPU（玩游戏）；启动路径用于重新加载。

## Model, token, and KV-cache effects

斜杠输入、shell 命令和确认信息都不进入模型请求。命令在宿主端运行，只追加标准的 `command/run`/`command/done` 生命周期对，因此不触及任何模型上下文或会话历史。

## Usage

```
/local-model stop
/local-model start
/local-model status
```

## Configuration

所有字段均可选；默认值面向原生 Windows 的 `ninfer-serve.exe`（`C:\LocalModel\qwen\ninfer\bin\ninfer-windows-0.3.0-win64-cuda131\ninfer-serve.exe`，加载 `qwen3_8_27b.ninfer`）。其他部署可在 `cordis.yml` 中覆盖。

| Key | Default | Meaning |
| --- | --- | --- |
| `stopCommand` | `taskkill /IM ninfer-serve.exe /F` | 停止服务器，释放 GPU |
| `startCommand` | `Start-Process powershell … watchdog-llama.ps1` | 通过 watchdog 分离启动服务器 |
| `statusCommand` | `Get-Process ninfer-serve` 检查 | 报告运行/停止状态 |
| `timeoutMs` | `120000` | 单条控制命令的运行超时 |

命令在执行时解析 `ctx.shell`，当 shell seam 缺失时报告错误。

## Known Limitations and Deferred Work

`startCommand` 默认委托给 watchdog（`watchdog-llama.ps1`），后者持有完整的服务器启动参数，因此两者必须同步更新。该控件是斜杠命令，而非独立的头部按钮。
