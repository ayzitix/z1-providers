/**
 * Model discovery for one provider.
 *
 * This lives in the module, not in the SDK: the address (`/models`, `/api/tags`,
 * `/openai/models`), the query (`?api-version`, `?type=text`) and the response
 * shape are provider knowledge, and every one of them will grow exceptions. The
 * host only supplies the base URL, the credential and the retry policy through
 * `ctx.llm.get`.
 *
 * Nothing is cached here. The host caches the HTTP answer for a few minutes; a
 * second layer would only make a stale list look fresh.
 *
 * @module z1-providers/models
 */

import { readFileSync } from 'node:fs'

const ENDPOINTS_FILE = new URL('../data/models-endpoints.json', import.meta.url)

/** What a provider needs beyond `GET {baseURL}/models`. */
export const DEFAULT_ENDPOINT = Object.freeze({ path: '/models' })

let cachedEndpoints

/**
 * Hand-maintained address table, keyed by provider id.
 *
 * Empty today: every supported provider answers the standard path. It exists so
 * an exception is a data edit, not a change to the SDK or to a node.
 */
export function loadEndpoints() {
  if (cachedEndpoints === undefined) {
    const raw = JSON.parse(readFileSync(ENDPOINTS_FILE, 'utf8'))
    const providers = raw?.providers
    cachedEndpoints = providers !== null && typeof providers === 'object' ? providers : {}
  }
  return cachedEndpoints
}

/** Path, query and body-shape hints for one provider. */
export function endpointFor(providerId, endpoints = loadEndpoints()) {
  const entry = endpoints[providerId]
  if (entry === null || typeof entry !== 'object') return DEFAULT_ENDPOINT
  return {
    path: typeof entry.path === 'string' ? entry.path : DEFAULT_ENDPOINT.path,
    ...(entry.query !== null && typeof entry.query === 'object' ? { query: entry.query } : {}),
    ...(typeof entry.listField === 'string' ? { listField: entry.listField } : {}),
    ...(typeof entry.idField === 'string' ? { idField: entry.idField } : {}),
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The array of entries inside a catalog body, whatever the provider calls it. */
function listOf(parsed, endpoint) {
  if (Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return []
  if (endpoint.listField !== undefined) {
    const value = parsed[endpoint.listField]
    return Array.isArray(value) ? value : []
  }
  // OpenAI `{data:[…]}`, Ollama `{models:[{name}]}`, a few gateways `{result:[…]}`.
  for (const key of ['data', 'models', 'result', 'items']) {
    const value = parsed[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function idOf(entry, endpoint) {
  if (!isRecord(entry)) return undefined
  if (endpoint.idField !== undefined) {
    const value = entry[endpoint.idField]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  // `id` is the OpenAI contract; `name`/`model` are common elsewhere. An Ollama
  // name may carry a tag (`llama3:8b`), which is a valid id to send back.
  for (const key of ['id', 'model', 'name']) {
    const value = entry[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Ask the provider what it serves.
 *
 * Returns `{ ids, endpoint, status }`. A non-2xx answer becomes an Error that
 * names the path and the status: the node turns that into "set config.model",
 * because a provider without a catalog endpoint is not a bug we can fix here.
 */
export async function discoverModels(ctx, providerId, options = {}) {
  const endpoint = endpointFor(providerId, options.endpoints)
  if (ctx?.llm?.get === undefined) {
    throw new Error(
      `z1.providers: this runtime cannot read provider metadata for "${providerId}"; set config.model explicitly`,
    )
  }

  let response
  try {
    response = await ctx.llm.get({
      provider: providerId,
      path: endpoint.path,
      ...(endpoint.query === undefined ? {} : { query: endpoint.query }),
    })
  } catch (error) {
    throw new Error(
      `z1.providers: cannot read ${endpoint.path} for "${providerId}": ${error instanceof Error ? error.message : String(error)}. Set config.model explicitly.`,
    )
  }

  if (!response.ok) {
    const detail = String(response.body ?? '').slice(0, 200).trim()
    throw new Error(
      `z1.providers: "${providerId}" answered ${String(response.status)} for GET ${endpoint.path}${detail.length === 0 ? '' : `: ${detail}`}. Set config.model explicitly.`,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(response.body)
  } catch {
    throw new Error(
      `z1.providers: "${providerId}" returned a non-JSON body for GET ${endpoint.path}. Set config.model explicitly.`,
    )
  }

  const ids = []
  const seen = new Set()
  for (const entry of listOf(parsed, endpoint)) {
    const id = idOf(entry, endpoint)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return { ids, endpoint, status: response.status }
}
