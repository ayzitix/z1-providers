/**
 * Execution contract of a generated node: the request it builds, the outputs it
 * mirrors from `z1.llm.chat`, and the two errors a user can actually hit.
 *
 * The context is a stub the shape of `NodeContext`; nothing here touches the
 * network or the host.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allProviders, nodeIdFor, providerById } from '../lib/catalog.js'
import { nodes } from '../index.js'

interface Recorded {
  requests: unknown[]
  deltas: { port: string; chunk: unknown }[]
}

function makeContext(
  recorded: Recorded,
  options: { config?: unknown; inputs?: unknown; result?: unknown } = {},
) {
  return {
    config: options.config ?? {},
    inputs: options.inputs ?? {},
    input: options.inputs ?? {},
    runId: 'run_test',
    nodeId: 'z1.providers.test',
    path: 'provider',
    emit(port: string, chunk: unknown) {
      recorded.deltas.push({ port, chunk })
      return undefined
    },
    llm: {
      async chat(request: unknown, onDelta?: (delta: { type: string; text: string }) => void) {
        recorded.requests.push(request)
        onDelta?.({ type: 'text', text: 'po' })
        onDelta?.({ type: 'text', text: 'ng' })
        return (
          options.result ?? {
            message: { role: 'assistant', content: 'pong' },
            toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }],
            usage: { inputTokens: 3, outputTokens: 1 },
            stopReason: 'tool-calls',
          }
        )
      },
    },
    tools: { list: async () => [], call: async () => null },
    memory: undefined,
  }
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
  }
})

test('a supported provider builds the request and mirrors z1.llm.chat outputs', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('openai')
  const outputs = await node.execute(
    makeContext(recorded, {
      config: { model: 'gpt-4.1-mini', maxTokens: 64 },
      inputs: { prompt: 'hello', system: 'be terse' },
    }) as never,
  )

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
  assert.deepEqual(outputs.toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }])
})

test('config.model is optional and falls back to the deterministic default', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('openai')
  await node.execute(makeContext(recorded, { inputs: { prompt: 'hi' } }) as never)

  const expected = providerById('openai')
  assert.ok(expected !== undefined)
  const request = recorded.requests[0] as { model: { provider: string; model: string } }
  assert.equal(request.model.provider, 'openai')
  assert.match(request.model.model, /\S/)
})

test('an unknown model names five real ids', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('openai')
  await assert.rejects(
    node.execute(
      makeContext(recorded, { config: { model: 'gpt-nonexistent' }, inputs: { prompt: 'hi' } }) as never,
    ),
    (error: Error) => {
      assert.match(error.message, /unknown model "gpt-nonexistent"/)
      assert.match(error.message, /Known models: /)
      return true
    },
  )
  assert.equal(recorded.requests.length, 0, 'a bad model must not reach the provider')
})

test('an unsupported provider explains the missing transport and names models', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('anthropic')
  await assert.rejects(node.execute(makeContext(recorded) as never), (error: Error) => {
    assert.match(error.message, /z1 has no transport for it yet/)
    assert.match(error.message, /DESIGN\.md/)
    assert.match(error.message, /Models it would have offered: /)
    return true
  })
  assert.equal(recorded.requests.length, 0)
})

test('a no-base-url provider says how to add one', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('vercel')
  await assert.rejects(node.execute(makeContext(recorded) as never), (error: Error) =>
    /overrides\.json/.test(error.message),
  )
})

test('a connected system port wins over config.system and messages pass through', async () => {
  const recorded: Recorded = { requests: [], deltas: [] }
  const node = providerNode('openai')
  await node.execute(
    makeContext(recorded, {
      config: { model: 'gpt-4.1-mini', system: 'from config' },
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
