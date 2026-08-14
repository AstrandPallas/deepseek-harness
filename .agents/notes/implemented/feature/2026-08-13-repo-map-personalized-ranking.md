# Agent Note: Personalized definition-level repo map

Status: implemented

English | [中文](2026-08-13-repo-map-personalized-ranking.zh.md)

## Problem

`tool-repo-map` rendered a file-ranked list of top-level regex definitions. Two structural gaps limited its use as an orientation aid: ranking was file-granular (a key definition inside a low-ranking file never surfaced), and the map ignored the conversation (the files and identifiers the model was actually working with), while every call re-walked and re-read the whole workspace.

## Decision

- **File list.** `git ls-files --cached --others --exclude-standard -z` supplies the candidate list in a git repository (inheriting every `.gitignore`), falling back to the directory walk otherwise.
- **Definition-granularity ranking.** File-level PageRank (convergence-checked, Δ < 1e-6, capped at 100 iterations) distributes each file's rank across its per-identifier reference edges into a `path|graphName` score map; rendering orders definitions globally by that score, so one heavily referenced definition surfaces from anywhere. Method definitions carry a class-prefixed display name but keep the bare `graphName` the reference graph keys on.
- **Personalization.** Seeds and edge multipliers follow the conversation: `mentions` identifiers boost defining files and get a ×10 edge multiplier; `chat_files` get a seed boost, a ×50 referencer-edge multiplier, and definition pinning; focus paths pin at ×100; README/LICENSE/Makefile/package.json/pyproject.toml/Cargo.toml/go.mod pin near the top.
- **Rendering.** Each definition renders with its trimmed source line; definition-less files trail as bare paths. A token budget (`maxTokens`, default 4000, binary search over prefix sums with `gpt-tokenizer` o200k_base) fits the largest prefix, under a hard `maxOutputChars` ceiling.
- **Cache.** Extraction results cache per process keyed by workspace root + path, invalidated by mtime (256-entry cap).

## Alternatives considered

**Tree-sitter extraction.** Rejected for now: the WASM grammar assets and async initialization complicate the bundled runtime; the regex set now covers the reference-graph cases (classes, functions, methods, assigned constants, re-exports), and the limitation is recorded in the package README.

**Per-definition PageRank nodes.** Rejected: file-level convergence plus post-hoc edge distribution reproduces Aider's ranked-definitions output without doubling the node count.

## Consequences

Repeat calls on an unchanged workspace cost only the file list plus unchanged-mtime cache hits. The map is responsive to the task (mentions, chat files, focus) and to the budget (token fit), at the cost of a tokenizer dependency and per-call PageRank work.

## Verification

`map.spec.ts` pins gitignore behavior via the walk fallback, class-prefixed methods, arrow/assigned-constant extraction, source-line rendering, bare def-less paths, focus/mention/chat-file boosting, character-budget truncation, and token-budget fitting. A live smoke test on a temp git repository confirmed tracked-plus-unignored-untracked listing and mention-boosted definition ordering.
