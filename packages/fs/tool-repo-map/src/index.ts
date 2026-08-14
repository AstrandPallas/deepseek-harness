/**
 * Model-facing `repo_map` tool: a compact, ranked workspace structure map.
 * Walked files contribute their top-level definitions; a reference-graph
 * PageRank (ported from Aider's repomap) orders them by relevance, and the
 * result is bounded by character and definition budgets.
 *
 * @module @deepseek-ai/dsh-tool-repo-map
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildRepoMap } from './map.ts'

export const name = 'tool-repo-map'
export const inject = ['tools']

/** Plugin configuration: pipeline budgets. */
export interface Config {
  /** Cap on code files scanned. Defaults to 400. */
  maxFiles?: number
  /** Cap on rendered definitions. Defaults to 1500. */
  maxDefs?: number
  /** Token budget for the rendered map (binary-search fit over the ranked list). Defaults to 4000. */
  maxTokens?: number
  /** Output character budget: the hard ceiling the token fit can never exceed. Defaults to 20000. */
  maxOutputChars?: number
}

export const Config: z<Config> = z.object({
  maxFiles: z.natural().default(400),
  maxDefs: z.natural().default(1500),
  maxTokens: z.natural().default(4000),
  maxOutputChars: z.natural().default(20_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register the `repo_map` tool.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated pipeline budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxFiles, maxDefs, maxTokens, maxOutputChars } = config as ResolvedConfig
  ctx.tools.register(defineTool({
    name: 'repo_map',
    description: 'Build a compact, ranked map of the workspace codebase: file paths with their definitions (classes, functions, types, headings), ordered by relevance. Use this to orient in an unfamiliar repository instead of reading many files.',
    parameters: {
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Path substrings to prioritize; matching files are boosted to the top of the map.',
      },
      mentions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Identifier names (classes, functions) the conversation is currently discussing; files defining or using them are boosted.',
      },
      chat_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths of files the conversation has been reading or touching; they are pinned higher and their references are amplified.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30_000,
    // Read-only workspace scan: overlapping executions are safe.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { focus, mentions, chat_files } = args as { focus?: string[]; mentions?: string[]; chat_files?: string[] }
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const result = await buildRepoMap(
        cwd,
        {
          maxFiles,
          maxDefs,
          maxTokens,
          maxOutputChars,
          focus: focus ?? [],
          mentions: mentions ?? [],
          chatFiles: chat_files ?? [],
        },
        exec.signal,
      )
      return result.text
    },
  }))
}
