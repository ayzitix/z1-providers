/**
 * Generator contracts, against the three-provider fixture rather than the real
 * catalog: classification, the deterministic default model, override provenance,
 * pruning and byte-identical regeneration.
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { defaultModel, nodeIdFor } from '../lib/catalog.js'
import { readJson, runScript, tempDir } from './helpers.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATE = join(REPO, 'scripts', 'generate.ts')
const FIXTURE = join(REPO, 'tests', 'fixtures', 'api.json')
const OVERRIDES = join(REPO, 'data', 'overrides.json')

interface ModelRow {
  id: string
  cost?: Record<string, number>
  limit?: { context: number }
  modalities?: string[]
}

interface ProviderRow {
  id: string
  name: string
  env: string[]
  npm: string
  api?: string
  doc?: string
  transport: string
  protocol: string
  reason?: string
  models: ModelRow[]
}

interface Catalog {
  providers: ProviderRow[]
}

function provider(catalog: Catalog, id: string): ProviderRow {
  const found = catalog.providers.find((entry) => entry.id === id)
  assert.ok(found !== undefined, `catalog has no provider "${id}"`)
  return found
}

function generate(outDir: string, extra: string[] = []): void {
  const result = runScript(GENERATE, [
    '--from-json',
    FIXTURE,
    '--out',
    outDir,
    '--overrides',
    OVERRIDES,
    ...extra,
  ])
  assert.equal(result.status, 0, `generator failed: ${result.stderr}`)
}

const GENERATED = ['data/catalog.json', 'manifest.json', 'lib/providers.generated.js', 'index.js']

test('generator classifies the fixture and picks a default model deterministically', () => {
  const out = tempDir('z1prov-gen')
  generate(out)
  const catalog = readJson<Catalog>(join(out, 'data', 'catalog.json'))

  assert.deepEqual(
    catalog.providers.map((entry) => entry.id),
    ['acme', 'anthropic', 'groq'],
    'providers are sorted by id',
  )

  const acme = provider(catalog, 'acme')
  assert.equal(acme.transport, 'openai-completions')
  assert.equal(acme.api, 'https://api.acme.test/v1', 'the payload URL wins')
  // Tools first, then the widest window: acme-huge has 1M context but no tools.
  assert.equal(defaultModel(acme), 'acme-pro')
  assert.deepEqual(
    acme.models.map((model) => model.id),
    ['acme-huge', 'acme-legacy', 'acme-mini', 'acme-pro'],
    'models are sorted by id',
  )

  const pro = acme.models.find((model) => model.id === 'acme-pro')
  assert.ok(pro !== undefined)
  assert.deepEqual(pro.cost, { input: 3, output: 15, cache_read: 0.3 }, 'tiered prices are pruned')
  const legacy = acme.models.find((model) => model.id === 'acme-legacy')
  assert.ok(legacy !== undefined)
  assert.equal(legacy.cost, undefined)
  assert.equal(legacy.limit, undefined)
})

test('a provider with no api uses the hand-written override, with its provenance kept', () => {
  const out = tempDir('z1prov-override')
  generate(out)
  const catalog = readJson<Catalog>(join(out, 'data', 'catalog.json'))
  const overrides = readJson<{ providers: Record<string, { baseURL: string; doc: string }> }>(OVERRIDES)

  const groq = provider(catalog, 'groq')
  assert.equal(groq.transport, 'openai-completions')
  assert.equal(groq.api, overrides.providers['groq']!.baseURL)
  assert.equal(groq.api, 'https://api.groq.com/openai/v1')
  assert.match(overrides.providers['groq']!.doc, /^https:\/\//)
  assert.equal(defaultModel(groq), 'groq-a')
})

test('an anthropic provider is unsupported, not guessed into an OpenAI transport', () => {
  const out = tempDir('z1prov-anthropic')
  generate(out)
  const catalog = readJson<Catalog>(join(out, 'data', 'catalog.json'))
  const anthropic = provider(catalog, 'anthropic')

  assert.equal(anthropic.transport, 'unsupported')
  assert.equal(anthropic.reason, 'non-openai-protocol')
  assert.equal(anthropic.protocol, 'anthropic')
  assert.equal(anthropic.api, undefined)
  assert.equal(defaultModel(anthropic), 'claude-small')

  const nodes = readFileSync(join(out, 'lib', 'providers.generated.js'), 'utf8')
  assert.match(nodes, /id: "z1\.providers\.anthropic"/)
  assert.match(nodes, /speaks anthropic/)
})

test('manifest lists every fixture provider and grants only the supported ones', () => {
  const out = tempDir('z1prov-manifest')
  generate(out)
  const manifest = readJson<{
    id: string
    version: string
    nodes: { id: string; version: string; title: string; category: string }[]
    capabilities: { llm: { providers: string[] } }
    limits: { timeoutMs: number }
  }>(join(out, 'manifest.json'))

  assert.equal(manifest.id, 'com.z1.providers')
  assert.equal(manifest.version, '0.1.0')
  assert.deepEqual(
    manifest.nodes.map((node) => node.id),
    ['acme', 'anthropic', 'groq'].map((id) => nodeIdFor(id)),
  )
  assert.deepEqual(manifest.capabilities.llm.providers, ['acme', 'groq'])
  assert.equal(manifest.limits.timeoutMs, 300000)
  for (const node of manifest.nodes) {
    assert.equal(node.version, '1.0.0')
    assert.equal(node.category, 'provider')
  }
})

test('regeneration is byte-identical', () => {
  const out = tempDir('z1prov-idempotent')
  generate(out)
  const first = new Map(GENERATED.map((path) => [path, readFileSync(join(out, path), 'utf8')]))
  generate(out)
  for (const path of GENERATED) {
    assert.equal(readFileSync(join(out, path), 'utf8'), first.get(path), `${path} changed`)
  }
})

test('--check passes on a fresh generation and fails after an edit', () => {
  const out = tempDir('z1prov-check')
  generate(out)
  const ok = runScript(GENERATE, ['--from-json', FIXTURE, '--out', out, '--overrides', OVERRIDES, '--check'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /providers 3/)
  assert.match(ok.stdout, /models 8/)

  const manifestPath = join(out, 'manifest.json')
  const manifest = readJson<{ nodes: unknown[] }>(manifestPath)
  manifest.nodes.pop()
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const drifted = runScript(GENERATE, [
    '--from-json',
    FIXTURE,
    '--out',
    out,
    '--overrides',
    OVERRIDES,
    '--check',
  ])
  assert.equal(drifted.status, 1)
  assert.match(drifted.stderr, /manifest\.json does not match a fresh generation/)
  assert.match(drifted.stderr, /manifest lists 2 nodes, catalog has 3 providers/)
})
