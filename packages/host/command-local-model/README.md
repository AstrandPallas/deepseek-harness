# command-local-model

English | [中文](README.zh.md)

Human-facing `/local-model` slash command that stops, starts, or reports the local model server serving the local worker pool. The stop path exists so a user can free the GPU for gaming; the start path reloads it.

## Model, token, and KV-cache effects

The slash input, the shell command, and the acknowledgement are absent from model requests. The command runs host-side and appends only the standard `command/run`/`command/done` lifecycle pair, so no model context or session history is touched.

## Usage

```
/local-model stop
/local-model start
/local-model status
```

## Configuration

All fields are optional; defaults target the native Windows `ninfer-serve.exe` (`C:\LocalModel\qwen\ninfer\bin\ninfer-windows-0.3.0-win64-cuda131\ninfer-serve.exe` serving `qwen3_8_27b.ninfer`). Override in `cordis.yml` for another deployment.

| Key | Default | Meaning |
| --- | --- | --- |
| `stopCommand` | `taskkill /IM ninfer-serve.exe /F` | stops the server, freeing the GPU |
| `startCommand` | `Start-Process powershell … watchdog-llama.ps1` | starts the server detached via the watchdog |
| `statusCommand` | `Get-Process ninfer-serve` check | reports running/stopped |
| `timeoutMs` | `120000` | one control command's run timeout |

The command resolves `ctx.shell` at execution time and reports an error when the shell seam is absent.

## Known Limitations and Deferred Work

The `startCommand` default delegates to the watchdog (`watchdog-llama.ps1`), which owns the full server flag set, so the two must be updated in step. The control is a slash command, not a dedicated header button.
