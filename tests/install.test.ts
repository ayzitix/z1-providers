/**
 * The config installer: a merge, not a rewrite. It must keep keys it does not
 * own, keep other providers, and refuse to invent a provider that has no
 * transport or no base URL.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readJson, runScript, tempDir } from './helpers.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = join(REPO, 'scripts', 'install-providers.ts')

interface ProviderEntry {
  id: string
  protocol?: string
  envKey?: string
  baseURL?: string
  headers?: Record<string, string>
}

interface Config {
  providers: ProviderEntry[]
  live?: boolean
  note?: string
}

function install(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const file = args[args.indexOf('--file') + 1]
  assert.ok(file !== undefined)
  const result = runScript(INSTALL, args, env)
  return {
    ...result,
    exists: existsSync(file),
    read: (): Config => readJson<Config>(file),
  }
}

test('a fresh file gets exactly the chosen providers', () => {
  const dir = tempDir('install-fresh')
  const file = join(dir, 'z1.config.json')
  const result = install(['--file', file, '--only', 'openai,groq'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\+ openai \(openai-completions, OPENAI_API_KEY, https:\/\/api\.openai\.com\/v1\)/)
  assert.match(result.stdout, /\+ groq \(openai-completions, GROQ_API_KEY, https:\/\/api\.groq\.com\/openai\/v1\)/)

  const config = result.read()
  assert.deepEqual(
    config.providers.map((provider) => provider.id),
    ['openai', 'groq'],
  )
  for (const provider of config.providers) {
    assert.equal(provider.protocol, 'openai-completions')
    assert.match(provider.baseURL ?? '', /^https:\/\//)
    assert.match(provider.envKey ?? '', /_API_KEY$/)
  }
})

test('an existing file keeps unrelated keys and other providers', () => {
  const dir = tempDir('install-merge')
  const file = join(dir, 'z1.config.json')
  writeFileSync(
    file,
    JSON.stringify({
      live: true,
      note: 'hand written',
      providers: [
        { id: 'local', protocol: 'openai-completions', envKey: 'LOCAL_KEY', baseURL: 'http://localhost:1234/v1' },
        { id: 'openai', protocol: 'openai-completions', envKey: 'OPENAI_API_KEY', baseURL: 'https://proxy.example/v1', headers: { 'x-team': 'z1' } },
      ],
    }),
    'utf8',
  )

  const result = install(['--file', file, '--only', 'openai'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /~ openai \(baseURL https:\/\/proxy\.example\/v1 -> https:\/\/api\.openai\.com\/v1\)/)

  const config = result.read()
  assert.equal(config.live, true)
  assert.equal(config.note, 'hand written')
  const local = config.providers.find((provider) => provider.id === 'local')
  assert.ok(local !== undefined, 'an untouched provider must survive')
  assert.equal(local.baseURL, 'http://localhost:1234/v1')

  const openai = config.providers.find((provider) => provider.id === 'openai')
  assert.equal(openai?.baseURL, 'https://api.openai.com/v1')
  // A field this script does not own is kept on a provider it does update.
  assert.deepEqual(openai?.headers, { 'x-team': 'z1' })
})

test('--dry-run prints the plan and writes nothing', () => {
  const dir = tempDir('install-dry')
  const file = join(dir, 'z1.config.json')
  const result = install(['--file', file, '--only', 'cerebras', '--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\+ cerebras /)
  assert.match(result.stdout, /dry run: 1 added/)
  assert.equal(result.exists, false, 'a dry run must not create the file')
})

test('--only rejects an unknown provider and an unsupported one', () => {
  const dir = tempDir('install-reject')
  const file = join(dir, 'z1.config.json')

  const unknown = install(['--file', file, '--only', 'not-a-provider'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /is not a models\.dev provider/)

  const unsupported = install(['--file', file, '--only', 'anthropic'])
  assert.equal(unsupported.status, 1)
  assert.match(unsupported.stderr, /is unsupported: non-openai-protocol/)
  assert.equal(unsupported.exists, false)
})

test('a templated base URL is resolved from the environment', () => {
  const dir = tempDir('install-template')
  const file = join(dir, 'z1.config.json')
  const env = { ...process.env, NEON_AI_GATEWAY_BASE_URL: 'https://gateway.example/neon' }

  const result = install(['--file', file, '--only', 'neon'], env)
  assert.equal(result.status, 0, result.stderr)
  const config = result.read()
  assert.equal(config.providers[0]?.baseURL, 'https://gateway.example/neon/v1')
})

test('a missing template variable skips with --all and fails with --only', () => {
  const dir = tempDir('install-template-missing')
  const file = join(dir, 'z1.config.json')
  const env = { ...process.env }
  delete env['NEON_AI_GATEWAY_BASE_URL']

  const bulk = install(['--file', file, '--dry-run'], env)
  assert.equal(bulk.status, 0, bulk.stderr)
  assert.match(bulk.stdout, /- neon \(needs NEON_AI_GATEWAY_BASE_URL; skipped\)/)
  assert.match(bulk.stdout, /5 skipped/)

  const explicit = install(['--file', file, '--only', 'neon'], env)
  assert.equal(explicit.status, 1)
  assert.match(explicit.stderr, /needs NEON_AI_GATEWAY_BASE_URL/)
  assert.equal(explicit.exists, false)
})

test('running it twice is idempotent', () => {
  const dir = tempDir('install-twise')
  const file = join(dir, 'z1.config.json')
  assert.equal(install(['--file', file, '--only', 'openai,groq']).status, 0)
  const first = readFileSync(file, 'utf8')

  const second = install(['--file', file, '--only', 'openai,groq'])
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /= openai \(already configured\)/)
  assert.equal(readFileSync(file, 'utf8'), first)
})

test('--all is the default and --all with --only is a usage error', () => {
  const dir = tempDir('install-all')
  const file = join(dir, 'z1.config.json')
  const result = install(['--file', file, '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dry run: 206 added/)
  assert.match(result.stdout, /5 skipped/)

  const conflict = runScript(INSTALL, ['--file', file, '--all', '--only', 'openai'])
  assert.equal(conflict.status, 2)
  assert.match(conflict.stderr, /pass --all or --only, not both/)
})
