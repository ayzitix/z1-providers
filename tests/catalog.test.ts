/**
 * Invariants of the committed catalog: one node per provider, every node id is
 * legal, and every provider we cannot execute says why.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MODULE_ID,
  NODE_ID_PATTERN,
  NODE_VERSION,
  OPENAI_TRANSPORT,
  allProviders,
  defaultModel,
  loadCatalog,
  modelIds,
  nodeIdFor,
  providerById,
} from '../lib/catalog.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface ManifestNode {
  id: string
  version: string
  title: string
  description?: string
  category: string
}

interface Manifest {
  id: string
  version: string
  nodes: ManifestNode[]
  capabilities?: { llm?: { providers?: string[] } | true }
  limits?: { timeoutMs?: number }
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')) as Manifest
}

test('the catalog keeps the source and a provider count', () => {
  const catalog = loadCatalog()
  assert.equal(catalog.source, 'https://models.dev/api.json')
  assert.equal(catalog.providers.length, 236, 'provider count changed; regenerate and review')
  const total = catalog.providers.reduce((sum, provider) => sum + modelIds(provider).length, 0)
  assert.equal(total, 9135, 'model count changed; regenerate and review')
})

test('provider ids are unique and every one maps to a legal node id', () => {
  const ids = new Set()
  const nodeIds = new Set()
  for (const provider of allProviders()) {
    assert.ok(!ids.has(provider.id), `duplicate provider id "${provider.id}"`)
    ids.add(provider.id)

    const nodeId = nodeIdFor(provider.id)
    assert.match(nodeId, NODE_ID_PATTERN, `"${provider.id}" produced an illegal node id`)
    assert.ok(!nodeIds.has(nodeId), `duplicate node id "${nodeId}"`)
    nodeIds.add(nodeId)
  }
  assert.equal(nodeIds.size, 236)
})

test('a supported provider has a base URL and an OpenAI transport', () => {
  const supported = allProviders().filter(
    (provider) => provider.transport === OPENAI_TRANSPORT,
  )
  assert.equal(supported.length, 211)
  for (const provider of supported) {
    assert.equal(provider.protocol, 'openai-completions', provider.id)
    assert.equal(typeof provider.api, 'string', `${provider.id} has no base URL`)
    // Most roots are https. Two exceptions are legitimate: models.dev lists a
    // loopback provider, and five roots carry an account placeholder that the
    // installer resolves from the environment (`expandBaseUrl`).
    const api = provider.api ?? ''
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(api)
    const templated = /\$\{[A-Z][A-Z0-9_]*\}/.test(api)
    assert.ok(
      loopback || templated || /^https:\/\//.test(api),
      `${provider.id} has an unexpected base URL: ${api}`,
    )
    assert.ok(provider.env.length > 0, `${provider.id} has no env key`)
  }
})

test('every unsupported provider explains itself', () => {
  const unsupported = allProviders().filter(
    (provider) => provider.transport !== OPENAI_TRANSPORT,
  )
  assert.equal(unsupported.length, 25)
  for (const provider of unsupported) {
    assert.ok(
      provider.reason === 'no-base-url' || provider.reason === 'non-openai-protocol',
      `${provider.id} has an unexpected reason "${String(provider.reason)}"`,
    )
    if (provider.reason === 'no-base-url') {
      // `unknown` means the SDK package is not one we recognise, so even with a
      // URL the transport would be a guess. The installer refuses both kinds.
      assert.ok(
        provider.protocol === 'openai-completions' || provider.protocol === 'unknown',
        `${provider.id} has protocol "${provider.protocol}"`,
      )
    }
  }
  const byReason = unsupported.reduce((counts, provider) => {
    counts[provider.reason] = (counts[provider.reason] ?? 0) + 1
    return counts
  }, {} as Record<string, number>)
  assert.deepEqual(byReason, { 'no-base-url': 13, 'non-openai-protocol': 12 })
})

test('templated base URLs are the documented five providers', () => {
  const templated = allProviders().filter((provider) => (provider.api ?? '').includes('${'))
  assert.deepEqual(
    templated.map((provider) => provider.id),
    ['cloudflare-workers-ai', 'databricks', 'infomaniak', 'neon', 'snowflake-cortex'],
  )
  for (const provider of templated) {
    assert.equal(provider.transport, 'openai-completions', provider.id)
    assert.match(provider.api ?? '', /\$\{[A-Z][A-Z0-9_]*\}/, provider.id)
  }
})

test('the default model is deterministic and belongs to the provider', () => {
  for (const provider of allProviders()) {
    const first = defaultModel(provider)
    const second = defaultModel({ ...provider, models: [...provider.models].reverse() })
    assert.equal(first, second, `${provider.id} default model depends on input order`)
    if (first !== undefined) assert.ok(modelIds(provider).includes(first), provider.id)
  }
})

test('the manifest matches the catalog and grants only supported providers', () => {
  const document = manifest()
  assert.equal(document.id, MODULE_ID)
  assert.equal(document.version, '0.1.0')
  assert.equal(document.nodes.length, 236)
  assert.equal(document.limits?.timeoutMs, 300_000)

  const catalogNodes = new Set(allProviders().map((provider) => nodeIdFor(provider.id)))
  for (const node of document.nodes) {
    assert.equal(node.version, NODE_VERSION)
    assert.equal(node.category, 'provider')
    assert.ok(catalogNodes.has(node.id), `manifest has a node with no provider: ${node.id}`)
  }

  const granted = document.capabilities?.llm
  assert.ok(granted !== undefined && granted !== true, 'llm capability must list providers')
  const listed = new Set(granted.providers ?? [])
  assert.equal(listed.size, 211)
  for (const id of listed) {
    const provider = providerById(id)
    assert.ok(provider !== undefined, `grant names unknown provider "${id}"`)
    assert.equal(provider.transport, OPENAI_TRANSPORT, `grant names unsupported provider "${id}"`)
  }
})

test('an unknown provider id is a null lookup, not a throw', () => {
  assert.equal(providerById('no-such-provider'), undefined)
})
