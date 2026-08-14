import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepoMap } from '../src/map.ts'
import type { RepoMapOptions } from '../src/map.ts'

let dirs: string[] = []

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repomap-'))
  dirs.push(dir)
  await writeFile(join(dir, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(dir, 'a.ts'), [
    'export class Foo {',
    '  bar() {}',
    '}',
    'export function helper() {}',
    '',
  ].join('\n'))
  await writeFile(join(dir, 'b.ts'), [
    'import { Foo } from "./a"',
    'const x = new Foo()',
    '',
  ].join('\n'))
  await writeFile(join(dir, 'data.sql'), 'SELECT 1;\n')
  await writeFile(join(dir, 'c.ts'), [
    'export const handler = () => {}',
    '',
  ].join('\n'))
  await writeFile(join(dir, 'notes.md'), '# Project Title\n\n## Section One\n')
  await writeFile(join(dir, 'ignored.ts'), 'export class Ignored {}\n')
  return dir
}

const SIGNAL = new AbortController().signal

function opts(overrides: Partial<RepoMapOptions> = {}): RepoMapOptions {
  return { maxFiles: 400, maxDefs: 1500, maxTokens: 4000, maxOutputChars: 20_000, focus: [], mentions: [], chatFiles: [], ...overrides }
}

afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe('repo map pipeline', () => {
  it('walks, extracts, and renders a ranked map while honouring .gitignore', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts(), SIGNAL)

    expect(result.stats.filesScanned).toBe(5)
    expect(result.text).toContain('a.ts:')
    expect(result.text).toContain('class Foo | export class Foo {')
    expect(result.text).toContain('method Foo.bar')
    expect(result.text).toContain('function helper')
    expect(result.text).toContain('c.ts:')
    expect(result.text).toContain('const handler')
    expect(result.text).toContain('h1 Project Title')
    expect(result.text).toContain('h2 Section One')
    expect(result.text).not.toContain('Ignored')
    // The file defining a referenced symbol ranks above its referencer.
    expect(result.text.indexOf('a.ts:')).toBeLessThan(result.text.indexOf('b.ts:'))
    // Assigned identifiers are captured as definitions.
    expect(result.text).toContain('const x | const x = new Foo()')
    // Definition-less files render as bare paths, not empty section headers.
    expect(result.text).not.toContain('data.sql:')
    expect(result.text.split('\n').some(line => line.trim() === 'data.sql')).toBe(true)
  })

  it('boosts focused paths above their graph rank', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts({ focus: ['c.ts'] }), SIGNAL)

    expect(result.text.startsWith('Repo map: 5 files\nc.ts:'))
  })

  it('boosts files defining mentioned identifiers', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts({ mentions: ['handler'] }), SIGNAL)

    expect(result.text.startsWith('Repo map: 5 files\nc.ts:'))
  })

  it('pins files the conversation has been reading', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts({ chatFiles: ['notes.md'] }), SIGNAL)

    expect(result.text.startsWith('Repo map: 5 files\nnotes.md:'))
  })

  it('truncates at the output budget', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts({ maxOutputChars: 40 }), SIGNAL)

    expect(result.stats.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(60)
  })

  it('fits the ranked list within the token budget', async () => {
    const root = await fixture()
    const result = await buildRepoMap(root, opts({ maxTokens: 20 }), SIGNAL)

    expect(result.stats.truncated).toBe(true)
    expect(result.stats.defsShown).toBeLessThan(result.stats.defsFound)
  })
})

async function makeFiles(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repomap-aider-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

function hasBareName(text: string, name: string): boolean {
  return text.split('\n').some(line => line.trim() === name)
}

describe('ported from aider test_repomap', () => {
  it('lists definition-less files as bare names with no section header', async () => {
    const root = await makeFiles({
      'empty1.py': '',
      'empty2.md': '',
      'pass_only.py': 'pass\n',
    })
    const result = await buildRepoMap(root, opts(), SIGNAL)

    expect(hasBareName(result.text, 'empty1.py')).toBe(true)
    expect(hasBareName(result.text, 'empty2.md')).toBe(true)
    expect(hasBareName(result.text, 'pass_only.py')).toBe(true)
    expect(result.text).not.toContain('empty1.py:')
    expect(result.text).not.toContain('pass_only.py:')
  })

  it('extracts Python class, method, and function definitions', async () => {
    const root = await makeFiles({
      'test_file_with_identifiers.py': [
        'class MyClass:',
        '    def my_method(self, arg1, arg2):',
        '        return arg1 + arg2',
        '',
        'def my_function(arg1, arg2):',
        '    return arg1 * arg2',
        '',
      ].join('\n'),
      'test_file_pass.py': 'pass\n',
    })
    const result = await buildRepoMap(root, opts(), SIGNAL)

    expect(result.text).toContain('test_file_with_identifiers.py:')
    expect(result.text).toContain('class MyClass')
    expect(result.text).toContain('method MyClass.my_method')
    expect(result.text).toContain('function my_function')
    expect(hasBareName(result.text, 'test_file_pass.py')).toBe(true)
    expect(result.text).not.toContain('test_file_pass.py:')
  })

  it('ranks the file defining a referenced symbol above its referencer', async () => {
    const root = await makeFiles({
      'definer.py': 'def helper():\n    return 1\n',
      'referencer.py': [
        'from definer import helper',
        '',
        'def consumer():',
        '    return helper()',
        '',
      ].join('\n'),
    })
    const result = await buildRepoMap(root, opts(), SIGNAL)

    expect(result.text.indexOf('definer.py:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('referencer.py:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('definer.py:')).toBeLessThan(result.text.indexOf('referencer.py:'))
  })

  it('boosts the file defining a mentioned identifier above other files', async () => {
    const root = await makeFiles({
      'service.py': 'def handler():\n    return 1\n',
      'consumer.py': [
        'from service import handler',
        '',
        'def other():',
        '    return handler()',
        '',
      ].join('\n'),
    })
    const result = await buildRepoMap(root, opts({ mentions: ['handler'] }), SIGNAL)

    expect(result.text.startsWith('Repo map: 2 files\nservice.py:')).toBe(true)
  })

  it('amplifies references made by chat files so the referenced file outranks a plain referencer target', async () => {
    const root = await makeFiles({
      'target.py': 'def target_fn():\n    pass\n',
      'other.py': 'def other_fn():\n    pass\n',
      'chat_ref.py': 'from target import target_fn\ntarget_fn()\n',
      'plain_ref.py': 'from other import other_fn\nother_fn()\n',
    })
    const result = await buildRepoMap(root, opts({ chatFiles: ['chat_ref.py'] }), SIGNAL)

    expect(result.text.indexOf('target.py:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('other.py:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('target.py:')).toBeLessThan(result.text.indexOf('other.py:'))
  })

  it('pins important documentation files like README near the top', async () => {
    const root = await makeFiles({
      'README.md': '# Project Title\n',
      'a.py': 'def foo():\n    pass\n',
    })
    const result = await buildRepoMap(root, opts(), SIGNAL)

    expect(result.text.indexOf('README.md:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('a.py:')).toBeGreaterThanOrEqual(0)
    expect(result.text.indexOf('README.md:')).toBeLessThan(result.text.indexOf('a.py:'))
  })
})
