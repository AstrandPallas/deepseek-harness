/**
 * Core repo-map pipeline: list files (git-tracked when the workspace is a
 * repository), extract definitions, rank with a reference-graph PageRank
 * personalized by recency, focus, mentions, and chat files (the approach
 * ported from Aider's repomap.py), then distribute file rank across the
 * per-definition edges and render a bounded structure tree.
 *
 * @module dsh-tool-repo-map/map
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { encode } from 'gpt-tokenizer'

const execFileAsync = promisify(execFile)

/** Pipeline options with defaults already resolved by the caller. */
export interface RepoMapOptions {
  /** Cap on code files scanned. */
  maxFiles: number
  /** Cap on rendered definitions. */
  maxDefs: number
  /** Token budget for the rendered map; the largest fitting prefix of the ranked list is emitted. */
  maxTokens: number
  /** Output character budget: the hard ceiling the token fit can never exceed. */
  maxOutputChars: number
  /** Path substrings that boost a file's rank. */
  focus: readonly string[]
  /** Identifiers the conversation is discussing; files defining them are boosted. */
  mentions: readonly string[]
  /** Files the conversation has been reading or touching; they seed the map and amplify their references. */
  chatFiles: readonly string[]
}

/** Per-call accounting for the tool result. */
export interface RepoMapStats {
  filesScanned: number
  defsFound: number
  defsShown: number
  truncated: boolean
}

export interface RepoMapResult {
  text: string
  stats: RepoMapStats
}

/** One extracted definition. */
interface Def {
  /** Display name (class-prefixed for methods). */
  name: string
  /** Bare name as written in source; the reference graph keys on this. */
  graphName: string
  kind: string
  /** The trimmed source line the definition was found on, truncated. */
  line: string
}

/** One scanned code file. */
interface FileInfo {
  path: string
  mtimeMs: number
  defs: Def[]
  idents: Set<string>
}

// ── file list ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '__pycache__',
  '.venv', 'venv', '.next', '.cache', '.turbo', 'target',
])

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.sh', '.bash', '.md', '.yaml',
  '.yml', '.toml', '.json', '.rb', '.php', '.kt', '.swift', '.sql',
])

const MAX_FILE_BYTES = 256 * 1024

/** One file-list candidate: metadata only; contents are read after selection. */
interface Candidate {
  path: string
  mtimeMs: number
}

/**
 * List the workspace's git-tracked files plus untracked files that are not
 * ignored, which inherits every .gitignore (root and nested) for free.
 * Returns undefined when the directory is not a git repository or git cannot
 * run, so the caller falls back to the walk.
 * @param root - workspace root.
 * @param signal - cooperative cancellation.
 */
async function gitTrackedFiles(root: string, signal: AbortSignal): Promise<Candidate[] | undefined> {
  if (signal.aborted) return undefined
  let stdout: string
  try {
    const result = await execFileAsync(
      'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
    )
    stdout = result.stdout
  } catch {
    // Not a git repository, git absent, or the run was cancelled: the caller
    // falls back to the directory walk rather than surfacing tooling noise.
    return undefined
  }
  const candidates: Candidate[] = []
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0) continue
    const rel = entry.replaceAll('\\', '/')
    if (!CODE_EXTENSIONS.has(extname(rel).toLowerCase())) continue
    try {
      const info = await stat(join(root, rel))
      if (info.size > MAX_FILE_BYTES) continue
      candidates.push({ path: rel, mtimeMs: info.mtimeMs })
    } catch {
      // A tracked path that vanished between listing and stat: skip it.
      continue
    }
  }
  return candidates
}

interface IgnoreRule {
  regex: RegExp
  negated: boolean
}

/** Translate one .gitignore line into a path matcher (last match wins). */
function gitignoreRule(line: string): IgnoreRule | undefined {
  let pattern = line.trim()
  if (pattern.length === 0 || pattern.startsWith('#')) return undefined
  const negated = pattern.startsWith('!')
  if (negated) pattern = pattern.slice(1)
  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  if (pattern.length === 0) return undefined
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*'
        i++
      } else {
        body += '[^/]*'
      }
    } else if (char === '?') {
      body += '[^/]'
    } else {
      body += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    }
  }
  return { regex: new RegExp(anchored ? `^${body}` : `(?:^|.*/)${body}`), negated }
}

/**
 * Parse the root .gitignore into ordered rules. Only the git-tracked path
 * inherits nested .gitignore files; this walk fallback reads the root one.
 */
async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  try {
    const raw = await readFile(join(root, '.gitignore'), 'utf8')
    return raw.split(/\r?\n/).map(gitignoreRule).filter((rule): rule is IgnoreRule => rule !== undefined)
  } catch {
    // No root .gitignore: nothing to ignore beyond the hardcoded skips.
    return []
  }
}

function isIgnored(relPath: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.regex.test(relPath)) ignored = !rule.negated
  }
  return ignored
}

async function collectCandidates(
  dir: string,
  root: string,
  rules: readonly IgnoreRule[],
  candidates: Candidate[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // An unreadable directory is pruned from the walk, not a hard failure.
    return
  }
  for (const entry of entries) {
    if (signal.aborted) return
    const abs = join(dir, entry.name)
    const rel = relative(root, abs).split(sep).join('/')
    if (isIgnored(rel, rules)) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await collectCandidates(abs, root, rules, candidates, signal)
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue
      const ext = extname(entry.name).toLowerCase()
      if (!CODE_EXTENSIONS.has(ext)) continue
      try {
        const info = await stat(abs)
        if (info.size > MAX_FILE_BYTES) continue
        candidates.push({ path: rel, mtimeMs: info.mtimeMs })
      } catch {
        // A file that vanished between readdir and stat: skip it.
        continue
      }
    }
  }
}

// ── extraction ──────────────────────────────────────────────────────────────

interface DefPattern {
  kind: string
  regex: RegExp
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'await', 'new',
  'typeof', 'instanceof', 'delete', 'void', 'case', 'default', 'else', 'do',
  'try', 'finally', 'in', 'of', 'import', 'export', 'class', 'function', 'var',
  'let', 'const', 'static', 'async', 'get', 'set', 'yield', 'break', 'continue',
  'public', 'private', 'protected', 'readonly', 'abstract', 'extends',
  'implements', 'package', 'interface', 'enum', 'type', 'namespace', 'declare',
  'module', 'require', 'from', 'as', 'is', 'not', 'and', 'or', 'with', 'print',
  'assert', 'global', 'lambda', 'None', 'True', 'False', 'self', 'fn', 'pub',
  'impl', 'trait', 'struct', 'match', 'select', 'where', 'elif', 'pass',
])

const JS_TS: DefPattern[] = [
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'const', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/gm },
  { kind: 'const', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+|require\s*\(|import\s*\()/gm },
  { kind: 'const', regex: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', regex: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'export', regex: /^\s*export\s*\{([^}]*)\}/gm },
  { kind: 'method', regex: /^\s{2,}(?:(?:static|async|get|set|public|private|protected|readonly|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm },
]

const PY: DefPattern[] = [
  { kind: 'class', regex: /^class\s+([A-Za-z_]\w*)/gm },
  { kind: 'class', regex: /^\s+class\s+([A-Za-z_]\w*)/gm },
  { kind: 'function', regex: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
  { kind: 'method', regex: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
  { kind: 'const', regex: /^([A-Z][A-Z0-9_]{2,})\s*=/gm },
]

const GO: DefPattern[] = [
  { kind: 'type', regex: /^type\s+([A-Za-z_]\w*)/gm },
  { kind: 'function', regex: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/gm },
]

const RS: DefPattern[] = [
  { kind: 'function', regex: /^(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/gm },
  { kind: 'type', regex: /^(?:pub\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm },
  { kind: 'trait', regex: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm },
  { kind: 'impl', regex: /^impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/gm },
]

const C_LIKE: DefPattern[] = [
  { kind: 'type', regex: /^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|record|struct|union|enum)\s+([A-Za-z_]\w*)/gm },
  { kind: 'function', regex: /^[\w\s:<>*&,[\]\\.]*\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|$)/gm },
]

const SH: DefPattern[] = [
  { kind: 'function', regex: /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{?/gm },
]

const MD: DefPattern[] = [
  { kind: 'h1', regex: /^#\s+(.+)$/gm },
  { kind: 'h2', regex: /^##\s+(.+)$/gm },
  { kind: 'h3', regex: /^###\s+(.+)$/gm },
]

const YAML_LIKE: DefPattern[] = [
  { kind: 'key', regex: /^([A-Za-z_][\w-]*)\s*:/gm },
]

const TOML: DefPattern[] = [
  { kind: 'section', regex: /^\[(.+)\]$/gm },
  { kind: 'key', regex: /^([A-Za-z_][\w-]*)\s*=/gm },
]

const DEF_PATTERNS: Record<string, DefPattern[]> = {
  '.ts': JS_TS, '.tsx': JS_TS, '.js': JS_TS, '.jsx': JS_TS, '.mjs': JS_TS, '.cjs': JS_TS,
  '.py': PY, '.go': GO, '.rs': RS,
  '.java': C_LIKE, '.c': C_LIKE, '.h': C_LIKE, '.cpp': C_LIKE, '.hpp': C_LIKE, '.cc': C_LIKE, '.cs': C_LIKE,
  '.sh': SH, '.bash': SH, '.md': MD, '.yaml': YAML_LIKE, '.yml': YAML_LIKE, '.toml': TOML,
  '.json': YAML_LIKE, '.rb': C_LIKE, '.php': C_LIKE, '.kt': C_LIKE, '.swift': C_LIKE, '.sql': [],
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g
const MAX_IDENTS_PER_FILE = 2000
const MAX_DEFS_PER_FILE = 200
const MAX_SOURCE_LINE_CHARS = 120

/** The trimmed source line containing a match offset, truncated to a fixed width. */
function sourceLine(content: string, index: number): string {
  const start = content.lastIndexOf('\n', index - 1) + 1
  let end = content.indexOf('\n', index)
  if (end === -1) end = content.length
  const line = content.slice(start, end).trim()
  return line.length > MAX_SOURCE_LINE_CHARS ? `${line.slice(0, MAX_SOURCE_LINE_CHARS - 1)}…` : line
}

interface ExtractResult {
  defs: Def[]
  idents: Set<string>
}

/**
 * Extract definitions from one source file. Matches are replayed in document
 * order so indented methods inherit their enclosing class for display
 * (`Foo.bar`) while the reference graph keeps the bare name (`bar`).
 * @param content - file text.
 * @param ext - lowercase file extension selecting the pattern set.
 */
function extract(content: string, ext: string): ExtractResult {
  const patterns = DEF_PATTERNS[ext] ?? []
  const matches: { index: number; kind: string; name: string }[] = []
  for (const { regex, kind } of patterns) {
    for (const match of content.matchAll(regex)) {
      const raw = match[1] ?? ''
      const name = raw.trim().slice(0, 60)
      if (name.length === 0 || RESERVED.has(name)) continue
      matches.push({ index: match.index, kind, name })
    }
  }
  matches.sort((left, right) => left.index - right.index)
  const defs: Def[] = []
  const seen = new Set<string>()
  let currentClass: string | undefined
  for (const match of matches) {
    if (match.kind === 'export') {
      // `export { A, B }` re-exports: each listed name is a definition alias.
      for (const piece of match.name.split(',')) {
        const name = piece.trim().split(/\s+as\s+/).at(-1)?.trim() ?? ''
        if (name.length === 0 || RESERVED.has(name) || seen.has(name)) continue
        seen.add(name)
        defs.push({ name, graphName: name, kind: 'export', line: sourceLine(content, match.index) })
      }
      continue
    }
    const displayName = match.kind === 'method' && currentClass !== undefined
      ? `${currentClass}.${match.name}`
      : match.name
    if (seen.has(displayName)) continue
    seen.add(displayName)
    defs.push({
      name: displayName,
      graphName: match.name,
      kind: match.kind,
      line: sourceLine(content, match.index),
    })
    if (match.kind === 'class') currentClass = match.name
  }
  const idents = new Set<string>()
  for (const match of content.matchAll(IDENT_RE)) {
    const name = match[0]
    if (RESERVED.has(name)) continue
    idents.add(name)
    if (idents.size >= MAX_IDENTS_PER_FILE) break
  }
  return { defs, idents }
}

// ── extraction cache ────────────────────────────────────────────────────────

const TAG_CACHE_CAP = 256

/** Per-process extraction cache keyed by workspace root + path, invalidated by mtime. */
const tagCache = new Map<string, { mtimeMs: number; result: ExtractResult }>()

function cachedExtract(root: string, path: string, mtimeMs: number, content: string): ExtractResult {
  const key = `${root}|${path}`
  const cached = tagCache.get(key)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.result
  const result = extract(content, extname(path).toLowerCase())
  if (tagCache.size >= TAG_CACHE_CAP) tagCache.clear()
  tagCache.set(key, { mtimeMs, result })
  return result
}

// ── ranking ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const RECENCY_DAYS = 30
const ALPHA = 0.85
const CONVERGENCE_TOLERANCE = 1e-6
const MAX_ITERATIONS = 100
const MENTION_SEED = 50
const CHAT_FILE_SEED = 25
const IMPORTANT_FILE_SEED = 10

/** Files always pinned near the top: the workspace's own documentation. */
const IMPORTANT_FILENAMES = /^(readme|license|copying|makefile|package\.json|pyproject\.toml|cargo\.toml|go\.mod)/i

/** File-level PageRank outcome plus per-definition scores distributed across edges. */
interface RankResult {
  fileRanks: Map<string, number>
  /** `${path}|${graphName}` → accumulated rank from every reference edge. */
  defRanks: Map<string, number>
}

/**
 * Rank files with a reference-graph PageRank personalized by modification
 * recency, explicit focus paths, mentioned identifiers, and chat files, then
 * distribute each file's rank across its per-definition reference edges
 * (Aider's definition-level scoring). Edge weight follows Aider:
 * sqrt(reference count) times meaningfulness multipliers (private ×0.1,
 * defined-in-many-files ×0.1, compound meaningful names ×10, mentioned
 * idents ×10, chat-file referencers ×50).
 * @param files - scanned files with definitions and identifier sets.
 * @param focus - path substrings that boost a file's seed.
 * @param mentions - identifiers the conversation is discussing.
 * @param chatFiles - files the conversation has been reading or touching.
 * @param now - current timestamp for recency decay.
 */
function buildRanks(
  files: readonly FileInfo[],
  focus: readonly string[],
  mentions: readonly string[],
  chatFiles: readonly string[],
  now: number,
): RankResult {
  // Bare-name definers: the graph keys on the identifier as written in source.
  const definers = new Map<string, Set<string>>()
  for (const file of files) {
    for (const def of file.defs) {
      let set = definers.get(def.graphName)
      if (set === undefined) {
        set = new Set()
        definers.set(def.graphName, set)
      }
      set.add(file.path)
    }
  }
  const chatFileSet = new Set(chatFiles)
  const mentionSet = new Set(mentions.filter(mention => mention.length > 0))
  // Global reference counts so self-edges only attach to unreferenced definitions.
  const globalRefCounts = new Map<string, number>()
  for (const file of files) {
    for (const ident of file.idents) {
      if (!definers.has(ident)) continue
      globalRefCounts.set(ident, (globalRefCounts.get(ident) ?? 0) + 1)
    }
  }
  interface Edge { from: string; to: string; ident: string; weight: number }
  const edges: Edge[] = []
  const addEdge = (from: string, to: string, ident: string, weight: number): void => {
    if (weight <= 0) return
    edges.push({ from, to, ident, weight })
  }
  for (const file of files) {
    const refCounts = new Map<string, number>()
    for (const ident of file.idents) {
      if (!definers.has(ident)) continue
      refCounts.set(ident, (refCounts.get(ident) ?? 0) + 1)
    }
    for (const [ident, count] of refCounts) {
      const targets = definers.get(ident)
      if (targets === undefined) continue
      let multiplier = 1
      if (ident.startsWith('_')) multiplier *= 0.1
      if (targets.size > 5) multiplier *= 0.1
      if (ident.length >= 8 && /[a-z]/.test(ident) && /[A-Z_-]/.test(ident)) multiplier *= 10
      if (mentionSet.has(ident)) multiplier *= 10
      if (chatFileSet.has(file.path)) multiplier *= 50
      const weight = Math.sqrt(count) * multiplier
      for (const target of targets) addEdge(file.path, target, ident, weight)
    }
  }
  // A definition nothing references keeps a small self-edge so its file
  // still flows rank (Aider's per-unreferenced-def self-edge).
  for (const file of files) {
    for (const def of file.defs) {
      if ((globalRefCounts.get(def.graphName) ?? 0) === 0) {
        addEdge(file.path, file.path, def.graphName, 0.1)
      }
    }
  }
  const seeds = new Map<string, number>()
  for (const file of files) {
    let seed = Math.exp(-(now - file.mtimeMs) / (RECENCY_DAYS * DAY_MS)) + 1e-3
    for (const item of focus) {
      if (file.path.includes(item)) seed += 100
    }
    if (chatFileSet.has(file.path)) seed += CHAT_FILE_SEED
    if (mentionSet.size > 0) {
      const mentioned = file.defs.some(def => mentionSet.has(def.graphName))
        || file.defs.some(def => mentionSet.has(def.name.split('.').at(-1) ?? ''))
        || [...file.idents].some(ident => mentionSet.has(ident))
        || file.path.split('/').some(part => mentionSet.has(part))
      if (mentioned) seed += MENTION_SEED
    }
    if (IMPORTANT_FILENAMES.test(basename(file.path))) seed += IMPORTANT_FILE_SEED
    seeds.set(file.path, seed)
  }
  const total = [...seeds.values()].reduce((sum, value) => sum + value, 0)
  for (const [path, value] of seeds) seeds.set(path, value / total)

  const nodes = files.map(file => file.path)
  const outWeight = new Map<string, number>()
  for (const edge of edges) outWeight.set(edge.from, (outWeight.get(edge.from) ?? 0) + edge.weight)
  let rank = new Map<string, number>()
  for (const node of nodes) rank.set(node, seeds.get(node) ?? 1 / nodes.length)
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = new Map<string, number>()
    let dangling = 0
    for (const node of nodes) {
      const weight = outWeight.get(node)
      if (weight === undefined || weight === 0) {
        dangling += rank.get(node) ?? 0
      } else {
        for (const edge of edges) {
          if (edge.from !== node) continue
          next.set(edge.to, (next.get(edge.to) ?? 0) + (rank.get(node) ?? 0) * edge.weight / weight)
        }
      }
    }
    for (const node of nodes) {
      const seed = seeds.get(node) ?? 1 / nodes.length
      next.set(node, (1 - ALPHA) * seed + ALPHA * ((next.get(node) ?? 0) + dangling * seed))
    }
    let maxDelta = 0
    for (const node of nodes) {
      maxDelta = Math.max(maxDelta, Math.abs((next.get(node) ?? 0) - (rank.get(node) ?? 0)))
    }
    rank = next
    if (maxDelta < CONVERGENCE_TOLERANCE) break
  }
  // Distribute converged file rank across each reference edge into the
  // definition it names, so one heavily referenced definition surfaces even
  // from a low-ranking file.
  const defRanks = new Map<string, number>()
  for (const edge of edges) {
    const weight = outWeight.get(edge.from)
    if (weight === undefined || weight === 0) continue
    const contribution = (rank.get(edge.from) ?? 0) * edge.weight / weight
    const key = `${edge.to}|${edge.ident}`
    defRanks.set(key, (defRanks.get(key) ?? 0) + contribution)
  }
  // Explicitly focused paths and files the conversation has been reading
  // outrank everything the graph flow surfaces, at file and definition level.
  for (const file of files) {
    if (!focus.some(item => file.path.includes(item)) && !chatFileSet.has(file.path)) continue
    rank.set(file.path, (rank.get(file.path) ?? 0) * 100)
    for (const def of file.defs) {
      const key = `${file.path}|${def.graphName}`
      defRanks.set(key, (defRanks.get(key) ?? 0) * 100)
    }
  }
  // Important documentation files pin near the top regardless of graph flow.
  for (const file of files) {
    if (!IMPORTANT_FILENAMES.test(basename(file.path))) continue
    rank.set(file.path, (rank.get(file.path) ?? 0) * 100)
    for (const def of file.defs) {
      const key = `${file.path}|${def.graphName}`
      defRanks.set(key, (defRanks.get(key) ?? 0) * 100)
    }
  }
  return { fileRanks: rank, defRanks }
}

// ── rendering ───────────────────────────────────────────────────────────────

const DEFS_PER_FILE_SHOWN = 25

/** One rendered output line plus how many definitions it carries. */
interface MapLine {
  text: string
  defs: number
}

/**
 * Token count for budget fitting. o200k_base is a close enough proxy for the
 * models that consume this map; the budget is a target, not a wire contract.
 */
function tokenCount(text: string): number {
  try {
    return encode(text).length
  } catch {
    // A tokenizer input edge (e.g. an unpaired surrogate) must not break the
    // map: fall back to the crude 4-chars-per-token estimate.
    return Math.ceil(text.length / 4)
  }
}

function renderMap(files: readonly FileInfo[], ranks: RankResult, opts: RepoMapOptions): RepoMapResult {
  const scored = files.map((file) => {
    let top = 0
    const defScores = new Map<string, number>()
    for (const def of file.defs) {
      const score = ranks.defRanks.get(`${file.path}|${def.graphName}`) ?? 0
      defScores.set(def.name, score)
      if (score > top) top = score
    }
    return { file, defScores, top }
  })
  const withDefs = scored
    .filter(entry => entry.file.defs.length > 0)
    .sort((a, b) => b.top - a.top || (ranks.fileRanks.get(b.file.path) ?? 0) - (ranks.fileRanks.get(a.file.path) ?? 0))
  const withoutDefs = scored
    .filter(entry => entry.file.defs.length === 0)
    .sort((a, b) => (ranks.fileRanks.get(b.file.path) ?? 0) - (ranks.fileRanks.get(a.file.path) ?? 0))
  const lines: MapLine[] = [{ text: `Repo map: ${files.length} files\n`, defs: 0 }]
  let defsShown = 0
  let defsFound = 0
  let defCapped = false
  for (const { file, defScores } of withDefs) {
    defsFound += file.defs.length
    lines.push({ text: `${file.path}:\n`, defs: 0 })
    const byScore = [...file.defs]
      .sort((a, b) => (defScores.get(b.name) ?? 0) - (defScores.get(a.name) ?? 0))
      .slice(0, DEFS_PER_FILE_SHOWN)
    for (const def of byScore) {
      if (defsShown >= opts.maxDefs) {
        defCapped = true
        break
      }
      lines.push({ text: `  ${def.kind} ${def.name} | ${def.line}\n`, defs: 1 })
      defsShown++
    }
    if (defCapped) break
    if (file.defs.length > DEFS_PER_FILE_SHOWN) {
      lines.push({ text: `  ⋮ (${file.defs.length - DEFS_PER_FILE_SHOWN} more)\n`, defs: 0 })
    }
  }
  // Definition-less files trail the ranked structure as bare paths (Aider's
  // shape): they exist and may matter, but nothing in them ranked.
  for (const { file } of withoutDefs) {
    lines.push({ text: `${file.path}\n`, defs: 0 })
  }
  // Token-budget fit: the largest line prefix whose token count stays within
  // `maxTokens`. Prefix sums are monotone, so a binary search lands in log n
  // (Aider's fit loop over the ranked tags).
  const prefix = [0]
  let running = 0
  for (const line of lines) {
    running += tokenCount(line.text)
    prefix.push(running)
  }
  let include = lines.length
  if (running > opts.maxTokens) {
    let low = 0
    let high = include
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((prefix[mid] ?? 0) <= opts.maxTokens) low = mid
      else high = mid - 1
    }
    include = low
  }
  let text = ''
  let truncated = include < lines.length || defCapped
  for (const line of lines.slice(0, include)) {
    if (text.length + line.text.length > opts.maxOutputChars) {
      truncated = true
      break
    }
    text += line.text
  }
  return {
    text,
    stats: {
      filesScanned: files.length,
      defsFound,
      defsShown: lines.slice(0, include).reduce((sum, line) => sum + line.defs, 0),
      truncated,
    },
  }
}

// ── pipeline ───────────────────────────────────────────────────────────────

/**
 * List, extract, rank, and render one workspace's structure map.
 * @param root - workspace root directory.
 * @param opts - resolved pipeline options.
 * @param signal - cooperative cancellation for the file list and reads.
 * @returns the bounded map text and per-call statistics.
 */
export async function buildRepoMap(
  root: string,
  opts: RepoMapOptions,
  signal: AbortSignal,
): Promise<RepoMapResult> {
  const tracked = await gitTrackedFiles(root, signal)
  let candidates: Candidate[]
  if (tracked !== undefined) {
    candidates = tracked
  } else {
    const rules = await loadIgnoreRules(root)
    candidates = []
    await collectCandidates(root, root, rules, candidates, signal)
  }
  const focused = candidates.filter(candidate => opts.focus.some(item => candidate.path.includes(item)))
  const rest = candidates
    .filter(candidate => !opts.focus.some(item => candidate.path.includes(item)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const selected = [...focused, ...rest].slice(0, opts.maxFiles)
  const files: FileInfo[] = []
  for (const candidate of selected) {
    if (signal.aborted) break
    // An unreadable file contributes no definitions; the walk already stat'ed
    // it, so treat it as empty rather than failing the whole map.
    const content = await readFile(join(root, candidate.path), 'utf8').catch(() => '')
    const extracted = cachedExtract(root, candidate.path, candidate.mtimeMs, content)
    files.push({
      path: candidate.path,
      mtimeMs: candidate.mtimeMs,
      defs: extracted.defs.slice(0, MAX_DEFS_PER_FILE),
      idents: extracted.idents,
    })
  }
  const ranks = buildRanks(files, opts.focus, opts.mentions, opts.chatFiles, Date.now())
  return renderMap(files, ranks, opts)
}
