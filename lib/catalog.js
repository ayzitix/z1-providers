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

/** Sorted model ids for a provider, or `[]`. */
export function modelIds(provider) {
  return Array.isArray(provider?.models) ? provider.models.map((model) => model.id) : []
}

/**
 * Deterministic default model: prefer a model that can call tools, then the
 * largest context window, then the lower id. Falls back to every model when a
 * provider ships none with tool support.
 */
export function defaultModel(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : []
  if (models.length === 0) return undefined
  const toolModels = models.filter((model) => model.tool_call === true)
  const pool = toolModels.length > 0 ? toolModels : models
  const [best] = [...pool].sort(compareModels)
  return best?.id
}

function compareModels(a, b) {
  const left = typeof a?.limit?.context === 'number' ? a.limit.context : -1
  const right = typeof b?.limit?.context === 'number' ? b.limit.context : -1
  if (left !== right) return right - left
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** Up to `count` model ids, for an error message. */
export function sampleModelIds(provider, count = 5) {
  return modelIds(provider).slice(0, count)
}

/** The message an unsupported provider throws, models included. */
export function unsupportedMessage(provider) {
  const parts = [
    `provider "${provider.id}" speaks ${provider.protocol}; z1 has no transport for it yet (see DESIGN.md).`,
  ]
  if (provider.reason === 'no-base-url') {
    parts.push(
      'No API base URL is known for it; add one to data/overrides.json and regenerate.',
    )
  }
  const sample = sampleModelIds(provider)
  if (sample.length > 0) {
    parts.push(`Models it would have offered: ${sample.join(', ')}.`)
  }
  return parts.join(' ')
}

/** The message an unknown model throws, five real ids included. */
export function unknownModelMessage(provider, model) {
  const ids = modelIds(provider)
  const sample = sampleModelIds(provider)
  const rest = ids.length - sample.length
  const tail = rest > 0 ? ` (${rest} more)` : ''
  return `${nodeIdFor(provider.id)}: unknown model "${model}" for provider "${provider.id}". Known models: ${sample.join(', ')}${tail}.`
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
  const model = config.model ?? defaultModel(provider)
  if (!modelIds(provider).includes(model)) {
    throw new Error(unknownModelMessage(provider, model))
  }

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

  const result = await ctx.llm.chat(request, (delta) => {
    if (delta.type !== 'text' || delta.text.length === 0) return
    ctx.emit('text', delta.text)
  })

  return {
    text: result.message.content,
    message: result.message,
    toolCalls: [...result.toolCalls],
    usage: result.usage === undefined ? {} : result.usage,
    hasToolCalls: result.toolCalls.length > 0,
    out: true,
  }
}
