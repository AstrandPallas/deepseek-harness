# @deepseek-ai/dsh-tool-repo-map

English | [中文](README.zh.md)

Model-facing `repo_map` tool: a compact, ranked workspace structure map built from the workspace's source files. Definitions are extracted per language, ranked with a reference-graph PageRank personalized by recency, focus paths, mentioned identifiers, and chat files, and the result is fitted to a token budget.

## What it does

- Lists files via `git ls-files --cached --others --exclude-standard` when the workspace is a git repository (inheriting every `.gitignore`), falling back to a directory walk with the root `.gitignore` and hardcoded skips otherwise.
- Extracts class/function/type/const definitions (class-prefixed methods, arrow functions, assigned constants, re-exports, markdown headings, config keys) and captures one source line per definition.
- Ranks definition-level: file-level PageRank (convergence-checked) distributes each file's rank across its per-identifier reference edges, so one heavily referenced definition surfaces even from a low-ranking file. Seeds boost recency, `focus` paths, `mentions` identifiers (plus an edge multiplier), `chat_files` (plus a referencer-edge multiplier and definition pinning), and important files (README/LICENSE/Makefile/package.json/pyproject.toml/Cargo.toml/go.mod).
- Renders the largest line prefix that fits the token budget (`maxTokens`, binary search over prefix sums, `gpt-tokenizer` o200k_base) under a hard `maxOutputChars` ceiling; definition-less files trail as bare paths.

## Configuration

```yaml
- id: tool-repo-map
  name: '@deepseek-ai/dsh-tool-repo-map'
  config:
    maxFiles: 400        # cap on code files scanned
    maxDefs: 1500        # cap on rendered definitions
    maxTokens: 4000      # token budget for the rendered map
    maxOutputChars: 20000 # hard character ceiling
```

Tool parameters: `focus` (path substrings boosted to the top), `mentions` (identifier names the conversation is discussing), `chat_files` (paths the conversation has been reading).

## Model experience

- **Tokens**, one tool result of at most `maxTokens` tokens (approximately, per the o200k_base encoder) and `maxOutputChars` characters.
- **KV cache / context**, read-only workspace scan; overlapping executions are safe, and results cache by file mtime within the process.
- **Durability**, nothing durable; every call re-derives from the current files.

## Known Limitations and Deferred Work

- **Regex extraction, not tree-sitter**, per-language regular expressions capture the reference-graph cases (classes, functions, methods, assigned constants, re-exports) but miss finer tree-sitter captures (parameters, struct fields, enum members). Adopting tree-sitter grammars was assessed and declined for now: the WASM grammar assets and async initialization complicate the bundled runtime for marginal orientation value.
- **Walk fallback reads only the root `.gitignore`**, the git-tracked path inherits nested ignore files; the non-repository fallback does not.
- **o200k_base is a proxy encoding**, the token budget targets the models that consume the map; it is a fit, not a wire contract.
