/**
 * Execution contract of a generated node: the request it builds, the live model
 * discovery behind `config.model`, and the errors a user can actually hit.
 *
 * The context is a stub the shape of `NodeContext`; nothing here touches the
 * network or the host.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allProviders, nodeIdFor } from '../lib/catalog.js'
import { nodes } from '../index.js'

interface Recorded {
  requests: unknown[]
  deltas: { port: string; chunk: unknown }[]
  logs: { level: string; message: string }[]
  getCalls: { provider: string; path: string }[]
}

interface ContextOptions {
  config?: unknown
  inputs?: unknown
  /** Body the fake provider returns from `ctx.llm.get`. */
  catalog?: unknown
  catalogStatus?: number
  getError?: Error
  chat?: (request: unknown) => unknown
}

function makeContext(recorded: Recorded, options: ContextOptions = {}) {
  return {
    config: options.config ?? {},
    inputs: options.inputs ?? {},
    input: options.inputs ?? {},
    runId: 'run_test',
    nodeId: 'z1.providers.test',
    path: 'provider',
    log(level: string, message: string) {
      recorded.logs.push({ level, message })
    },
    emit(port: string, chunk: unknown) {
      recorded.deltas.push({ port, chunk })
      return undefined
    },
    llm: {
      async get(request: { provider: string; path: string }) {
        recorded.getCalls.push({ provider: request.provider, path: request.path })
        if (options.getError !== undefined) throw options.getError
        const status = options.catalogStatus ?? 200
        return {
          status,
          ok: status >= 200 && status < 300,
          body: JSON.stringify(
            options.catalog ?? { data: [{ id: 'listed-a' }, { id: 'listed-b' }] },
          ),
          truncated: false,
        }
      },
      async chat(request: unknown, onDelta?: (delta: { type: string; text: string }) => void) {
        recorded.requests.push(request)
        if (options.chat !== undefined) return await options.chat(request)
        onDelta?.({ type: 'text', text: 'po' })
        onDelta?.({ type: 'text', text: 'ng' })
        return {
          message: { role: 'assistant', content: 'pong' },
          toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }],
          usage: { inputTokens: 3, outputTokens: 1 },
          stopReason: 'tool-calls',
        }
      },
    },
    tools: { list: async () => [], call: async () => null },
    memory: undefined,
  }
}

function fresh(): Recorded {
  return { requests: [], deltas: [], logs: [], getCalls: [] }
}

function providerNode(providerId: string) {
  const id = nodeIdFor(providerId)
  const found = nodes.find((node) => node.id === id)
  assert.ok(found !== undefined, `no node for provider "${providerId}"`)
  return found
}

test('one node per catalog provider, in the same order', () => {
  assert.equal(nodes.length, 236)
  const providers = allProviders()
  assert.deepEqual(
    nodes.map((node) => node.id),
    providers.map((provider) => nodeIdFor(provider.id)),
  )
  for (const node of nodes) {
    assert.equal(node.version, '1.0.0')
    assert.equal(node.category, 'provider')
    assert.equal(node.cacheable, false, 'a model turn must never be cached')
    assert.deepEqual(node.defaultConfig, {}, 'no model is baked in')
  }
})

test('a pinned model is used without a discovery call', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  const outputs = await node.execute(
    makeContext(recorded, {
      config: { model: 'gpt-4.1-mini', maxTokens: 64 },
      inputs: { prompt: 'hello', system: 'be terse' },
    }) as never,
  )

  assert.deepEqual(recorded.getCalls, [], 'a pinned model costs no lookup')
  assert.deepEqual(recorded.requests, [
    {
      model: { provider: 'openai', model: 'gpt-4.1-mini' },
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ],
      maxTokens: 64,
    },
  ])
  assert.deepEqual(recorded.deltas, [
    { port: 'text', chunk: 'po' },
    { port: 'text', chunk: 'ng' },
  ])
  assert.equal(outputs.text, 'pong')
  assert.equal(outputs.hasToolCalls, true)
  assert.equal(outputs.out, true)
  assert.deepEqual(outputs.usage, { inputTokens: 3, outputTokens: 1 })
})

test('without config.model the node takes the first live id and says so', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await node.execute(
    makeContext(recorded, {
      config: {},
      inputs: { prompt: 'hi' },
      catalog: { data: [{ id: 'live-first' }, { id: 'live-second' }] },
    }) as never,
  )

  assert.deepEqual(recorded.getCalls, [{ provider: 'openai', path: '/models' }])
  const request = recorded.requests[0] as { model: { model: string } }
  assert.equal(request.model.model, 'live-first')
  const warning = recorded.logs.find((entry) => entry.level === 'warn')
  assert.ok(warning !== undefined, 'defaulting to the first id must be visible')
  assert.match(warning.message, /no model configured/)
  assert.match(warning.message, /pin it with config\.model/)
})

test('an empty live list fails instead of guessing', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await assert.rejects(
    node.execute(
      makeContext(recorded, { config: {}, inputs: { prompt: 'hi' }, catalog: { data: [] } }) as never,
    ),
    /listed no models; set config\.model explicitly/,
  )
})

test('a provider without discovery says so and names the fallback', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await assert.rejects(
    node.execute(
      makeContext(recorded, {
        config: {},
        inputs: { prompt: 'hi' },
        getError: new Error('fetch failed: ECONNREFUSED'),
      }) as never,
    ),
    (error: Error) => {
      assert.match(error.message, /cannot read \/models for "openai"/)
      assert.match(error.message, /ECONNREFUSED/)
      assert.match(error.message, /Set config\.model explicitly/)
      return true
    },
  )
})

test('an unsupported provider explains the missing transport', async () => {
  const recorded = fresh()
  const node = providerNode('anthropic')
  await assert.rejects(node.execute(makeContext(recorded) as never), (error: Error) => {
    assert.match(error.message, /z1 has no transport for it yet/)
    assert.match(error.message, /DESIGN\.md/)
    return true
  })
  assert.equal(recorded.requests.length, 0)
  assert.equal(recorded.getCalls.length, 0, 'no discovery for a provider we cannot call')
})

test('a no-base-url provider says how to add one', async () => {
  const recorded = fresh()
  const node = providerNode('vercel')
  await assert.rejects(node.execute(makeContext(recorded) as never), (error: Error) =>
    /overrides\.json/.test(error.message),
  )
})

test('a model-not-found error is enriched with the live ids', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await assert.rejects(
    node.execute(
      makeContext(recorded, {
        config: { model: 'gpt-retired' },
        inputs: { prompt: 'hi' },
        catalog: { data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] },
        chat: async () => {
          throw new Error('openai-compatible request failed (404 Not Found: model not found)')
        },
      }) as never,
    ),
    (error: Error) => {
      assert.match(error.message, /model not found/, 'the provider message is preserved')
      assert.match(error.message, /model "gpt-retired" is not served by "openai"/)
      assert.match(error.message, /gpt-a, gpt-b/)
      return true
    },
  )
})

test('an unrelated chat error is not padded with model ids', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await assert.rejects(
    node.execute(
      makeContext(recorded, {
        config: { model: 'gpt-a' },
        inputs: { prompt: 'hi' },
        chat: async () => {
          throw new Error('openai-compatible request failed (500 Internal Server Error)')
        },
      }) as never,
    ),
    (error: Error) => {
      assert.doesNotMatch(error.message, /is not served by/)
      return true
    },
  )
  assert.deepEqual(recorded.getCalls, [], 'no lookup for an error that is not about a model')
})

test('a connected system port wins over config.system and messages pass through', async () => {
  const recorded = fresh()
  const node = providerNode('openai')
  await node.execute(
    makeContext(recorded, {
      config: { model: 'gpt-a', system: 'from config' },
      inputs: {
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
        ],
        system: 'from port',
      },
    }) as never,
  )
  const request = recorded.requests[0] as { messages: { role: string; content: string }[] }
  assert.deepEqual(request.messages, [
    { role: 'system', content: 'from port' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ])
})
