/**
 * Discovery lives here, not in the SDK: the path, the query and the body shape
 * are provider knowledge. These tests pin the three shapes in the field and the
 * fact that an exception is a data edit.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_ENDPOINT, discoverModels, endpointFor } from '../lib/models.js'

interface Call {
  provider: string
  path: string
  query?: Record<string, string>
}

function ctxReturning(body: unknown, options: { status?: number; raw?: string } = {}) {
  const calls: Call[] = []
  const ctx = {
    llm: {
      async get(request: Call) {
        calls.push(request)
        const status = options.status ?? 200
        return {
          status,
          ok: status >= 200 && status < 300,
          body: options.raw ?? JSON.stringify(body),
          truncated: false,
        }
      },
    },
  }
  return { ctx, calls }
}

test('the default endpoint is GET /models with no query', () => {
  assert.deepEqual(DEFAULT_ENDPOINT, { path: '/models' })
  assert.deepEqual(endpointFor('anything', {}), DEFAULT_ENDPOINT)
})

test('an override supplies path, query and field names', () => {
  const endpoints = {
    venice: { path: '/models', query: { type: 'text' } },
    ollama: { path: '/api/tags', listField: 'models', idField: 'name' },
  }
  assert.deepEqual(endpointFor('venice', endpoints), {
    path: '/models',
    query: { type: 'text' },
  })
  assert.deepEqual(endpointFor('ollama', endpoints), {
    path: '/api/tags',
    listField: 'models',
    idField: 'name',
  })
  assert.deepEqual(endpointFor('openai', endpoints), DEFAULT_ENDPOINT)
})

test('OpenAI shape: {data:[{id}]}, deduped and order-preserving', async () => {
  const { ctx, calls } = ctxReturning({
    object: 'list',
    data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { object: 'model' }, { id: '' }],
  })
  const result = await discoverModels(ctx, 'openai')
  assert.deepEqual(result.ids, ['b', 'a'])
  assert.deepEqual(calls, [{ provider: 'openai', path: '/models' }])
})

test('Ollama shape: {models:[{name}]} through an override', async () => {
  const { ctx } = ctxReturning({ models: [{ name: 'llama3:8b' }, { name: 'qwen2.5:7b' }] })
  const result = await discoverModels(ctx, 'local', {
    endpoints: { local: { path: '/api/tags', listField: 'models', idField: 'name' } },
  })
  assert.deepEqual(result.ids, ['llama3:8b', 'qwen2.5:7b'])
})

test('a bare array is accepted, and other keys are ignored', async () => {
  const { ctx } = ctxReturning([{ model: 'm1' }, { id: 'm2' }])
  assert.deepEqual((await discoverModels(ctx, 'gw')).ids, ['m1', 'm2'])

  const other = ctxReturning({ object: 'list' })
  assert.deepEqual((await discoverModels(other.ctx, 'gw')).ids, [])
})

test('a non-2xx answer names the status and the path', async () => {
  const { ctx } = ctxReturning(undefined, { status: 404, raw: 'no such endpoint' })
  await assert.rejects(discoverModels(ctx, 'x'), (error: Error) => {
    assert.match(error.message, /"x" answered 404 for GET \/models/)
    assert.match(error.message, /no such endpoint/)
    assert.match(error.message, /Set config\.model explicitly/)
    return true
  })
})

test('a non-JSON answer is reported without leaking the body', async () => {
  const { ctx } = ctxReturning(undefined, { raw: '<html>nope</html>' })
  await assert.rejects(discoverModels(ctx, 'x'), /returned a non-JSON body/)
})

test('a transport failure keeps the underlying reason', async () => {
  const ctx = {
    llm: {
      async get() {
        throw new Error('fetch failed: ECONNREFUSED')
      },
    },
  }
  await assert.rejects(discoverModels(ctx, 'x'), /cannot read \/models for "x".*ECONNREFUSED/)
})

test('a runtime without metadata reads says so', async () => {
  await assert.rejects(discoverModels({}, 'x'), /cannot read provider metadata/)
})
