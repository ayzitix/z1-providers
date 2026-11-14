/**
 * Runtime helpers shared by every generated provider node.
 *
 * The catalog is read once from `data/catalog.json` (lazily: generating the
 * catalog must not require reading the previous one). Nothing here speaks HTTP:
 * a node builds a `ChatRequest` and hands it to `ctx.llm.chat`, so credentials,
 * retries and provider routing stay in the host.
 *
 * Node ids are qualified lower-kebab segments (`NODE_ID_PATTERN` in
 * `@z1/module/src/manifest.ts`). One upstream provider id, `302ai`, starts with
 * a digit and cannot be a node id, so {@link nodeIdFor} prefixes such ids with
 * `p-`; the provider id as written in a `ModelHandle` is always the catalog id.
 *
 * @module z1-providers/catalog
 */

import { readFileSync } from 'node:fs'

/** Prefix of every node this module contributes. */
export const NODE_ID_PREFIX = 'z1.providers.'

/**
 * Copy of the SPEC/@z1/module rule for a qualified node id: dotted lower-kebab
 * segments, the first segment starting with a letter.
 */
export const NODE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/

/** Every node in this module ships at this version. */
export const NODE_VERSION = '1.0.0'

/** Canvas grouping for every provider node. */
export const NODE_CATEGORY = 'provider'

/** Module id, repeated here so scripts and tests agree without reading JSON. */
export const MODULE_ID = 'com.z1.providers'

/** Transport that a node can actually execute today. */
export const OPENAI_TRANSPORT = 'openai-completions'

const CATALOG_FILE = new URL('../data/catalog.json', import.meta.url)

/**
 * Ports of every provider node, mirroring `z1.llm.chat` minus its `model` port
 * (the provider is the node, so only a model id is configurable). A graph can
 * therefore swap a provider node for `z1.llm.chat` without rewiring edges.
 *
 * These are the executable ports; the manifest adds JSON schemas and titles for
 * the UI, and the host resolves port schemas from the declaration.
 */
export const INPUT_PORTS = Object.freeze([
  Object.freeze({ kind: 'flow', id: 'in' }),
  Object.freeze({ kind: 'data', id: 'messages', required: false }),
  Object.freeze({ kind: 'data', id: 'tools', required: false }),
  Object.freeze({ kind: 'data', id: 'system', required: false }),
  Object.freeze({ kind: 'data', id: 'prompt', required: false }),
])

export const OUTPUT_PORTS = Object.freeze([
  Object.freeze({ kind: 'data', id: 'text' }),
  Object.freeze({ kind: 'data', id: 'message' }),
  Object.freeze({ kind: 'data', id: 'toolCalls' }),
  Object.freeze({ kind: 'data', id: 'usage' }),
  Object.freeze({ kind: 'data', id: 'hasToolCalls' }),
  Object.freeze({ kind: 'flow', id: 'out' }),
])

let cachedCatalog

/**
 * The provider id as a node id. Digits cannot start a segment, so a provider id
 * like `302ai` becomes `p-302ai`; everything else is used verbatim.
 */
export function nodeIdFor(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new TypeError('provider id must be a non-empty string')
  }
  const plain = `${NODE_ID_PREFIX}${providerId}`
  if (NODE_ID_PATTERN.test(plain)) return plain
  const qualified = `${NODE_ID_PREFIX}p-${providerId}`
  if (NODE_ID_PATTERN.test(qualified)) return qualified
  throw new TypeError(`provider id "${providerId}" cannot be a node id`)
}

/** Parse (once) and return the committed catalog document. */
export function loadCatalog() {
  if (cachedCatalog === undefined) {
    cachedCatalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  }
  return cachedCatalog
}

/** Every provider entry, in catalog (id) order. */
export function allProviders() {
  return loadCatalog().providers
}

/** One provider entry, or `undefined` when the id is unknown. */
export function providerById(providerId) {
  return allProviders().find((provider) => provider.id === providerId)
}

/**
 * Live model ids for a provider.
 *
 * Discovery goes through `ctx.llm.models`, so the host supplies the credential
 * and caches the answer; the module stores no list of its own. A provider that
 * does not implement `GET /models` fails here, and the caller must then name a
 * model explicitly.
 */
export async function listModels(ctx, providerId) {
  if (ctx?.llm?.models === undefined) {
    throw new Error(
      `z1.providers: this runtime cannot discover models for "${providerId}"; set config.model explicitly`,
    )
  }
  try {
    const models = await ctx.llm.models(providerId)
    return Array.isArray(models) ? models : []
  } catch (error) {
    throw new Error(
      `z1.providers: cannot discover models for "${providerId}": ${error instanceof Error ? error.message : String(error)}. Set config.model explicitly.`,
    )
  }
}

/** The message an unsupported provider throws. */
export function unsupportedMessage(provider) {
  const parts = [
    `provider "${provider.id}" speaks ${provider.protocol}; z1 has no transport for it yet (see DESIGN.md).`,
  ]
  if (provider.reason === 'no-base-url') {
    parts.push(
      'No API base URL is known for it; add one to data/overrides.json and regenerate.',
    )
  }
  return parts.join(' ')
}

/** First id the provider lists, used when the graph pins no model. */
async function firstModel(ctx, provider) {
  const models = await listModels(ctx, provider.id)
  const first = models[0]
  if (first === undefined) {
    throw new Error(
      `z1.providers: provider "${provider.id}" listed no models; set config.model explicitly`,
    )
  }
  ctx.log?.(
    'warn',
    `z1.providers: no model configured for "${provider.id}", using "${first.id}" from the live list (${models.length} available); pin it with config.model`,
  )
  return first.id
}

/** Errors that mean "this model id is not served", not "the request is broken". */
const MODEL_ERROR = /model|404|not found|does not exist|unknown|invalid/i

/**
 * Add the live catalog to a model error.
 *
 * Providers answer an unknown model very differently (`model_not_found`,
 * `400 invalid model`, a bare 404). The one useful thing we can add is the set
 * of ids that do work, fetched at the moment it matters.
 */
async function explainModelError(error, ctx, provider, model) {
  const message = error instanceof Error ? error.message : String(error)
  if (!MODEL_ERROR.test(message)) return error
  let models
  try {
    models = await listModels(ctx, provider.id)
  } catch {
    return error
  }
  if (models.length === 0) return error
  const sample = models.slice(0, 10).map((entry) => entry.id).join(', ')
  const tail = models.length > 10 ? `, … (${models.length} total)` : ''
  const hint = `model "${model}" is not served by "${provider.id}". Available: ${sample}${tail}`
  return new Error(`${message} — ${hint}`)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolCall(value) {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function toToolCalls(value) {
  if (!Array.isArray(value)) return []
  const calls = []
  for (const entry of value) {
    if (!isToolCall(entry)) continue
    calls.push({ id: entry.id, name: entry.name, arguments: entry.arguments ?? null })
  }
  return calls
}

function toMessages(value) {
  if (!Array.isArray(value)) return []
  const messages = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const { role, content } = entry
    if (typeof content !== 'string') continue
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    const message = { role, content }
    if (typeof entry.toolCallId === 'string') message.toolCallId = entry.toolCallId
    const toolCalls = toToolCalls(entry.toolCalls)
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    messages.push(message)
  }
  return messages
}

function toTools(value) {
  if (!Array.isArray(value)) return []
  const tools = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    const tool = {
      name: entry.name,
      parameters: isRecord(entry.parameters) ? entry.parameters : {},
    }
    if (typeof entry.description === 'string') tool.description = entry.description
    tools.push(tool)
  }
  return tools
}

/** `{ model, system, maxTokens }`, type-checked; unknown keys are ignored. */
export function readConfig(raw) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) throw new Error('z1.providers: config must be an object')

  const config = {}
  const { model, system, maxTokens } = raw
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error('z1.providers: config.model must be a non-empty string')
  }
  if (typeof model === 'string') config.model = model
  if (system !== undefined && typeof system !== 'string') {
    throw new Error('z1.providers: config.system must be a string')
  }
  if (typeof system === 'string') config.system = system
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error('z1.providers: config.maxTokens must be a positive integer')
    }
    config.maxTokens = maxTokens
  }
  return config
}

/**
 * Execute one provider node: resolve the model, build the request, delegate to
 * `ctx.llm.chat` and mirror `z1.llm.chat`'s outputs so the two are swappable.
 */
export async function chatWithProvider(providerId, ctx) {
  const provider = providerById(providerId)
  if (provider === undefined) {
    throw new Error(`z1.providers: provider "${providerId}" is not in the catalog`)
  }
  if (provider.transport !== OPENAI_TRANSPORT) {
    throw new Error(unsupportedMessage(provider))
  }

  const config = readConfig(ctx.config)
  // Discovery only when the graph did not pin a model: a pinned id costs no
  // lookup, which keeps a large graph from probing the provider on every node.
  const model = config.model ?? (await firstModel(ctx, provider))

  const values = isRecord(ctx.inputs) ? ctx.inputs : {}
  const messages = toMessages(values.messages)
  if (messages.length === 0 && typeof values.prompt === 'string') {
    messages.push({ role: 'user', content: values.prompt })
  }
  // A connected `system` port is authoritative; config.system is the fallback.
  const rawSystem = Object.hasOwn(values, 'system') ? values.system : config.system
  const system =
    typeof rawSystem === 'string' && rawSystem.trim() !== '' ? rawSystem : undefined
  const withSystem =
    system === undefined || messages[0]?.role === 'system'
      ? messages
      : [{ role: 'system', content: system }, ...messages]

  const request = { model: { provider: provider.id, model }, messages: withSystem }
  if (Object.hasOwn(values, 'tools')) request.tools = toTools(values.tools)
  if (config.maxTokens !== undefined) request.maxTokens = config.maxTokens

  let result
  try {
    result = await ctx.llm.chat(request, (delta) => {
      if (delta.type !== 'text' || delta.text.length === 0) return
      ctx.emit('text', delta.text)
    })
  } catch (error) {
    throw await explainModelError(error, ctx, provider, model)
  }

  return {
    text: result.message.content,
    message: result.message,
    toolCalls: [...result.toolCalls],
    usage: result.usage === undefined ? {} : result.usage,
    hasToolCalls: result.toolCalls.length > 0,
    out: true,
  }
}
