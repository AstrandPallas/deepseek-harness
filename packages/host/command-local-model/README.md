# command-local-model

Human-facing `/local-model` slash command that stops, starts, or reports the local model server serving the local worker pool. The stop path exists so a user can free the GPU for gaming; the start path reloads it.

## Model, token, and KV-cache effects

The slash input, the shell command, and the acknowledgement are absent from model requests. The command runs host-side and appends only the standard `command/run`/`command/done` lifecycle pair, so no model context or session history is touched.

## Usage

```
/local-model stop     # stop the server, freeing the GPU
/local-model start    # start (or restart) the server
/local-model status   # report whether the server is running
```

## Configuration

All fields are optional; defaults target the native Windows `llama-server.exe` (`C:\LocalModel\llama.cpp\llama-server.exe` serving `Qwen3.8-27B-UD-Q4_K_XL.gguf`). Override in `cordis.yml` for a WSL2 or other deployment.

| Key | Default | Meaning |
| --- | --- | --- |
| `stopCommand` | `taskkill /IM llama-server.exe /F` | stops the server, freeing the GPU |
| `startCommand` | `Start-Process llama-server.exe …` (full flag set) | starts the server detached |
| `statusCommand` | `Get-Process llama-server` check | reports running/stopped |
| `timeoutMs` | `120000` | one control command's run timeout |

The command resolves `ctx.shell` at execution time and reports an error when the shell seam is absent.

## Known Limitations and Deferred Work

The `startCommand` default duplicates the server's full launch flags, so it must be updated in step with the launcher (`dsh-web-local.ps1`). The control is a slash command, not a dedicated header button.
