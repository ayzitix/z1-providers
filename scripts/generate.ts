#!/usr/bin/env node
/**
 * Regenerates the committed provider module from a models.dev payload.
 *
 * The payload is `https://models.dev/api.json`, the built form of the
 * `anomalyco/models.dev` repository (one TOML file per provider). This script
 * deliberately does not parse TOML: pass the endpoint with `--from-url`, a saved
 * payload with `--from-json`, or a directory holding `api.json` with
 * `--from-dir` (which refreshes `data/catalog.json` only).
 *
 * Output is a pure function of the payload plus `data/overrides.json`, so two
 * runs produce identical bytes. `--check` re-runs the generator and fails on any
 * drift, and also prints the catalog health summary.
 *
 * Usage:
 *   node scripts/generate.ts --from-url [url]
 *   node scripts/generate.ts --from-json <file> [--out <dir>]
 *   node scripts/generate.ts --from-dir <dir>          # catalog only
 *   node scripts/generate.ts --check                   # counts + drift check
 *
 * @module z1-providers/scripts/generate
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INPUT_PORTS,
  MODULE_ID,
  NODE_CATEGORY,
  NODE_VERSION,
  OUTPUT_PORTS,
  defaultModel,
  nodeIdFor,
} from '../lib/catalog.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_URL = 'https://models.dev/api.json'
const CATALOG_SOFT_LIMIT_BYTES = 3 * 1024 * 1024

/** `npm` packages whose transport is the OpenAI completions protocol. */
const OPENAI_NPM = new Set([
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/groq',
  '@ai-sdk/cerebras',
  '@ai-sdk/xai',
  '@ai-sdk/deepinfra',
  '@ai-sdk/togetherai',
  '@ai-sdk/perplexity',
  '@ai-sdk/vercel',
])

/** `npm` packages that speak a protocol z1 has no transport for. */
const NON_OPENAI_PROTOCOL = new Map([
  ['@ai-sdk/anthropic', 'anthropic'],
  ['@ai-sdk/google', 'google'],
  ['@ai-sdk/amazon-bedrock', 'amazon-bedrock'],
  ['@ai-sdk/cohere', 'cohere'],
  ['@ai-sdk/mistral', 'mistral'],
])

const PORT_TITLES: Record<string, string> = {
  in: 'In',
  messages: 'Messages',
  tools: 'Tools',
  system: 'System',
  prompt: 'Prompt',
  text: 'Text',
  message: 'Message',
  toolCalls: 'Tool calls',
  usage: 'Usage',
  hasToolCalls: 'Has tool calls',
  out: 'Out',
}

const PORT_SCHEMAS: Record<string, Record<string, unknown>> = {
  messages: { type: 'array', items: { type: 'object' } },
  tools: { type: 'array', items: { type: 'object' } },
  system: { type: 'string' },
  prompt: { type: 'string' },
  text: { type: 'string' },
  message: { type: 'object' },
  toolCalls: { type: 'array', items: { type: 'object' } },
  usage: { type: 'object' },
  hasToolCalls: { type: 'boolean' },
}

const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: {
      type: 'string',
      description: 'Model id for this provider; omit to use the deterministic default.',
    },
    system: {
      type: 'string',
      description: 'System prompt used when no `system` input is connected.',
    },
    maxTokens: { type: 'integer', minimum: 1 },
  },
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

interface Options {
  fromUrl: string | undefined
  fromJson: string | undefined
  fromDir: string | undefined
  outDir: string
  overridesFile: string
  check: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    fromUrl: undefined,
    fromJson: undefined,
    fromDir: undefined,
    outDir: ROOT,
    overridesFile: join(ROOT, 'data', 'overrides.json'),
    check: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    const requireValue = (): string => {
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === '--from-url') {
      // The endpoint is the default source, so a bare `--from-url` is enough.
      if (next !== undefined && !next.startsWith('--')) {
        options.fromUrl = next
        index += 1
      } else {
        options.fromUrl = DEFAULT_URL
      }
    } else if (arg === '--from-json') {
      options.fromJson = requireValue()
    } else if (arg === '--from-dir') {
      options.fromDir = requireValue()
    } else if (arg === '--out') {
      options.outDir = resolve(requireValue())
    } else if (arg === '--overrides') {
      options.overridesFile = resolve(requireValue())
    } else if (arg === '--check' || arg === '--health') {
      options.check = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new UsageError(`unknown argument "${arg}"`)
    }
  }
  const sources = [options.fromUrl, options.fromJson, options.fromDir].filter(
    (entry) => entry !== undefined,
  )
  if (sources.length > 1) {
    throw new UsageError('pass only one of --from-url, --from-json, --from-dir')
  }
  return options
}

function printUsage(): void {
  process.stdout.write(
    [
      'usage: node scripts/generate.ts <source> [--out <dir>] [--overrides <file>]',
      '',
      '  --from-url [url]   fetch the models.dev endpoint (default URL when omitted)',
      '  --from-json <f>    read a saved api.json',
      '  --from-dir <dir>   read <dir>/api.json; refreshes data/catalog.json only',
      '  --check            print counts; with a source, fail on any byte drift',
      '',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// payload -> catalog
// ---------------------------------------------------------------------------

interface CostRow {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

interface ModelRow {
  id: string
  name: string
  limit?: { context: number }
  cost?: CostRow
  tool_call?: boolean
  reasoning?: boolean
  modalities?: string[]
}

interface ProviderRow {
  id: string
  name: string
  env: string[]
  npm: string
  api?: string
  doc?: string
  transport: 'openai-completions' | 'unsupported'
  protocol: string
  reason?: 'non-openai-protocol' | 'no-base-url'
  models: ModelRow[]
}

interface OverrideEntry {
  baseURL?: string
  doc?: string
  note?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOverrides(file: string): Record<string, OverrideEntry> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(raw) || !isRecord(raw['providers'])) {
    throw new Error(`${file}: expected { "providers": { ... } }`)
  }
  const overrides: Record<string, OverrideEntry> = {}
  for (const [id, value] of Object.entries(raw['providers'])) {
    if (!isRecord(value)) throw new Error(`${file}: providers.${id} must be an object`)
    const override: OverrideEntry = {}
    if (typeof value['baseURL'] === 'string') override.baseURL = value['baseURL']
    if (typeof value['doc'] === 'string') override.doc = value['doc']
    if (typeof value['note'] === 'string') override.note = value['note']
    overrides[id] = override
  }
  return overrides
}

function pruneCost(raw: unknown): CostRow | undefined {
  if (!isRecord(raw)) return undefined
  const cost: CostRow = {}
  // Keep the source's numbers as given: no rounding, no unit change. Tiered and
  // audio prices are outside the pruned contract (see README).
  for (const key of ['input', 'output', 'cache_read', 'cache_write'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) cost[key] = value
  }
  return Object.keys(cost).length > 0 ? cost : undefined
}

function pruneModel(raw: unknown): ModelRow | undefined {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return undefined
  const model: ModelRow = {
    id: raw['id'],
    name: typeof raw['name'] === 'string' ? raw['name'] : raw['id'],
  }
  const limit = raw['limit']
  if (isRecord(limit) && typeof limit['context'] === 'number') {
    model.limit = { context: limit['context'] }
  }
  const cost = pruneCost(raw['cost'])
  if (cost !== undefined) model.cost = cost
  if (typeof raw['tool_call'] === 'boolean') model.tool_call = raw['tool_call']
  if (typeof raw['reasoning'] === 'boolean') model.reasoning = raw['reasoning']
  if (Array.isArray(raw['modalities'])) {
    const modalities = raw['modalities'].filter((entry) => typeof entry === 'string')
    if (modalities.length > 0) model.modalities = modalities
  }
  return model
}

function classify(
  npm: string,
  payloadApi: string | undefined,
  override: OverrideEntry | undefined,
): Pick<ProviderRow, 'transport' | 'protocol' | 'reason' | 'api'> {
  // An explicit non-OpenAI package wins over a URL: `minimax` and its siblings
  // publish an `api`, but it is an Anthropic endpoint, not an OpenAI one.
  const protocol = NON_OPENAI_PROTOCOL.get(npm)
  if (protocol !== undefined) {
    return {
      transport: 'unsupported',
      protocol,
      reason: 'non-openai-protocol',
      ...(payloadApi === undefined ? {} : { api: payloadApi }),
    }
  }
  if (payloadApi !== undefined) {
    return { transport: 'openai-completions', protocol: 'openai-completions', api: payloadApi }
  }
  const overrideUrl = override?.baseURL?.trim()
  if (OPENAI_NPM.has(npm)) {
    if (overrideUrl !== undefined && overrideUrl !== '') {
      return { transport: 'openai-completions', protocol: 'openai-completions', api: overrideUrl }
    }
    // OpenAI-compatible package, but nowhere to send the request.
    return { transport: 'unsupported', protocol: 'openai-completions', reason: 'no-base-url' }
  }
  // An unknown SDK with no URL: the protocol is genuinely unknown, so say so.
  return { transport: 'unsupported', protocol: 'unknown', reason: 'no-base-url' }
}

function buildProvider(
  id: string,
  raw: Record<string, unknown>,
  overrides: Record<string, OverrideEntry>,
): ProviderRow {
  const npm = typeof raw['npm'] === 'string' ? raw['npm'] : ''
  const rawApi = raw['api']
  const payloadApi =
    typeof rawApi === 'string' && rawApi.trim() !== '' ? rawApi.trim() : undefined
  const models: ModelRow[] = []
  if (isRecord(raw['models'])) {
    for (const value of Object.values(raw['models'])) {
      const model = pruneModel(value)
      if (model !== undefined) models.push(model)
    }
  }
  // Sorted, not source-ordered: the payload's key order is an implementation
  // detail and the catalog must be byte-identical between runs.
  models.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))

  const name = raw['name']
  const doc = raw['doc']
  const env = raw['env']
  return {
    id,
    name: typeof name === 'string' && name !== '' ? name : id,
    env: Array.isArray(env) ? env.filter((entry): entry is string => typeof entry === 'string') : [],
    npm,
    ...(typeof doc === 'string' ? { doc } : {}),
    ...classify(npm, payloadApi, overrides[id]),
    models,
  }
}

function buildProviders(payload: unknown, overrides: Record<string, OverrideEntry>): ProviderRow[] {
  const source = isRecord(payload) && isRecord(payload['providers']) ? payload['providers'] : payload
  if (!isRecord(source)) throw new Error('payload must be an object keyed by provider id')
  return Object.keys(source)
    .sort()
    .map((id) => {
      const entry = source[id]
      if (!isRecord(entry)) throw new Error(`provider "${id}" is not an object`)
      return buildProvider(id, entry, overrides)
    })
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderCatalog(providers: ProviderRow[], source: string): string {
  const lines: string[] = [
    '{',
    '  "schemaVersion": 1,',
    `  "source": ${JSON.stringify(source)},`,
    '  "providers": [',
  ]
  providers.forEach((provider, providerIndex) => {
    const fields: string[] = [
      `"id": ${JSON.stringify(provider.id)}`,
      `"name": ${JSON.stringify(provider.name)}`,
      `"env": ${JSON.stringify(provider.env)}`,
      `"npm": ${JSON.stringify(provider.npm)}`,
    ]
    if (provider.api !== undefined) fields.push(`"api": ${JSON.stringify(provider.api)}`)
    if (provider.doc !== undefined) fields.push(`"doc": ${JSON.stringify(provider.doc)}`)
    fields.push(`"transport": ${JSON.stringify(provider.transport)}`)
    fields.push(`"protocol": ${JSON.stringify(provider.protocol)}`)
    if (provider.reason !== undefined) fields.push(`"reason": ${JSON.stringify(provider.reason)}`)

    // One model per line keeps the file reviewable in a diff at ~2.3 MB.
    const modelLines = provider.models.map((model) => `        ${JSON.stringify(model)}`)
    const modelField =
      modelLines.length === 0 ? '"models": []' : `"models": [\n${modelLines.join(',\n')}\n      ]`
    fields.push(modelField)

    const body = fields.map((field, index) => {
      const comma = index === fields.length - 1 ? '' : ','
      return `      ${field}${comma}`
    })
    const comma = providerIndex === providers.length - 1 ? '' : ','
    lines.push('    {', ...body, `    }${comma}`)
  })
  lines.push('  ]', '}', '')
  return lines.join('\n')
}

function declarationPorts(
  ports: readonly { kind: string; id: string; required?: boolean }[],
): Record<string, unknown>[] {
  return ports.map((port) => {
    if (port.kind === 'flow') {
      return { kind: 'flow', id: port.id, title: PORT_TITLES[port.id] }
    }
    const declared: Record<string, unknown> = {
      kind: 'data',
      id: port.id,
      title: PORT_TITLES[port.id],
      schema: PORT_SCHEMAS[port.id] ?? {},
    }
    if (port.required === false) declared['required'] = false
    return declared
  })
}

function describe(provider: ProviderRow): string {
  const count = provider.models.length
  const models = `${count} model${count === 1 ? '' : 's'}`
  if (provider.transport === 'openai-completions') {
    return `${provider.name} — ${models} over the openai-completions transport.`
  }
  if (provider.reason === 'no-base-url') {
    return `${provider.name} — ${models}; unsupported: no API base URL is known (see data/overrides.json).`
  }
  return `${provider.name} — ${models}; unsupported: speaks ${provider.protocol}, which z1 has no transport for (see DESIGN.md).`
}

function renderNodes(providers: ProviderRow[], source: string): string {
  const lines: string[] = [
    '/**',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * One node definition per models.dev provider. Generated by',
    ' * `scripts/generate.ts` from',
    ` * ${source}`,
    ' * Re-run the generator instead of patching this file.',
    ' *',
    ' * Every node delegates to `chatWithProvider` in `./catalog.js`. Unsupported',
    ' * providers are declared too, so a graph can be authored against the catalog;',
    ' * they throw an explanation at execution time.',
    ' *',
    ' * @module z1-providers/generated',
    ' */',
    '',
    "import { INPUT_PORTS, OUTPUT_PORTS, chatWithProvider } from './catalog.js'",
    '',
    'export const nodes = [',
  ]
  for (const provider of providers) {
    const model = defaultModel(provider)
    lines.push(
      '  {',
      `    id: ${JSON.stringify(nodeIdFor(provider.id))},`,
      `    version: ${JSON.stringify(NODE_VERSION)},`,
      `    title: ${JSON.stringify(provider.name)},`,
      `    description: ${JSON.stringify(describe(provider))},`,
      `    category: ${JSON.stringify(NODE_CATEGORY)},`,
      model === undefined
        ? '    defaultConfig: {},'
        : `    defaultConfig: { model: ${JSON.stringify(model)} },`,
      '    inputs: INPUT_PORTS,',
      '    outputs: OUTPUT_PORTS,',
      '    // A model turn costs money and may differ every time; never reuse it.',
      '    cacheable: false,',
      `    execute: (ctx) => chatWithProvider(${JSON.stringify(provider.id)}, ctx),`,
      '  },',
    )
  }
  lines.push(']', '')
  return lines.join('\n')
}

function renderIndex(): string {
  return [
    '/**',
    ' * `com.z1.providers` — one z1 node per models.dev provider.',
    ' *',
    ' * Every node mirrors the `z1.llm.chat` ports, so it can replace that node in a',
    ' * graph; the provider is fixed by the node and the model comes from config.',
    ' * Providers z1 has no transport for are listed as well, so a graph can be built',
    ' * against the real catalog and fails with an explanation at execution time.',
    ' *',
    ' * @module com.z1.providers',
    ' */',
    '',
    "export { nodes } from './lib/providers.generated.js'",
    "export { MODULE_ID, NODE_VERSION } from './lib/catalog.js'",
    '',
  ].join('\n')
}

interface ManifestNode {
  id: string
  version: string
  title: string
  category: string
  inputs: Record<string, unknown>[]
  outputs: Record<string, unknown>[]
  configSchema: unknown
}

function buildManifest(providers: ProviderRow[]): Record<string, unknown> {
  const supported = providers.filter((provider) => provider.transport === 'openai-completions')
  const nodes: ManifestNode[] = providers.map((provider) => ({
    id: nodeIdFor(provider.id),
    version: NODE_VERSION,
    title: provider.name,
    category: NODE_CATEGORY,
    inputs: declarationPorts(INPUT_PORTS),
    outputs: declarationPorts(OUTPUT_PORTS),
    configSchema: CONFIG_SCHEMA,
  }))
  return {
    schemaVersion: 1,
    id: MODULE_ID,
    version: '0.1.0',
    title: 'z1 providers',
    description:
      'One node per models.dev provider; each chat turn is routed through the provider catalog.',
    author: 'z1',
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    entry: 'index.js',
    nodes,
    capabilities: { llm: { providers: supported.map((provider) => provider.id) } },
    limits: { timeoutMs: 300000 },
  }
}

function renderManifest(providers: ProviderRow[]): string {
  return `${JSON.stringify(buildManifest(providers), null, 2)}\n`
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

interface Source {
  payload: unknown
  label: string
  catalogOnly: boolean
}

async function readSource(options: Options): Promise<Source> {
  if (options.fromUrl !== undefined) {
    const response = await fetch(options.fromUrl, {
      headers: { accept: 'application/json', 'user-agent': 'z1-providers/generate' },
    })
    if (!response.ok) {
      throw new Error(`${options.fromUrl}: HTTP ${response.status} ${response.statusText}`)
    }
    return { payload: await response.json(), label: options.fromUrl, catalogOnly: false }
  }
  if (options.fromJson !== undefined) {
    const file = resolve(options.fromJson)
    return {
      payload: JSON.parse(readFileSync(file, 'utf8')),
      label: `file://${file}`,
      catalogOnly: false,
    }
  }
  const dir = resolve(options.fromDir as string)
  const file = join(dir, 'api.json')
  return {
    payload: JSON.parse(readFileSync(file, 'utf8')),
    label: `file://${file}`,
    catalogOnly: true,
  }
}

// ---------------------------------------------------------------------------
// catalog health
// ---------------------------------------------------------------------------

interface Stats {
  providers: number
  supported: number
  unsupported: number
  byReason: Record<string, number>
  models: number
  supportedModels: number
}

function statsOf(providers: ProviderRow[]): Stats {
  const byReason: Record<string, number> = {}
  let supported = 0
  let supportedModels = 0
  let models = 0
  for (const provider of providers) {
    models += provider.models.length
    if (provider.transport === 'openai-completions') {
      supported += 1
      supportedModels += provider.models.length
    } else {
      const reason = provider.reason ?? 'unknown'
      byReason[reason] = (byReason[reason] ?? 0) + 1
    }
  }
  return {
    providers: providers.length,
    supported,
    unsupported: providers.length - supported,
    byReason,
    models,
    supportedModels,
  }
}

function formatStats(stats: Stats): string {
  const reasons = Object.keys(stats.byReason)
    .sort()
    .map((reason) => `${reason} ${stats.byReason[reason]}`)
    .join(', ')
  return [
    `providers ${stats.providers}: openai-completions ${stats.supported}, unsupported ${stats.unsupported}${reasons === '' ? '' : ` (${reasons})`}`,
    `models ${stats.models}: ${stats.supportedModels} on supported providers`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface GeneratedFile {
  path: string
  content: string
}

function generate(source: Source, providers: ProviderRow[]): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: join('data', 'catalog.json'), content: renderCatalog(providers, source.label) },
  ]
  if (source.catalogOnly) return files
  files.push(
    { path: 'manifest.json', content: renderManifest(providers) },
    { path: join('lib', 'providers.generated.js'), content: renderNodes(providers, source.label) },
    { path: 'index.js', content: renderIndex() },
  )
  return files
}

function writeFiles(outDir: string, files: GeneratedFile[]): void {
  for (const file of files) {
    const target = join(outDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
    process.stdout.write(`wrote ${file.path} (${file.content.length} bytes)\n`)
  }
}

function readCommitted(outDir: string, path: string): string | undefined {
  try {
    return readFileSync(join(outDir, path), 'utf8')
  } catch {
    return undefined
  }
}

/** Consistency of the committed catalog, manifest and node list. */
function checkCommitted(outDir: string, problems: string[]): ProviderRow[] | undefined {
  const catalogText = readCommitted(outDir, join('data', 'catalog.json'))
  const manifestText = readCommitted(outDir, 'manifest.json')
  if (catalogText === undefined) {
    problems.push('data/catalog.json is missing')
    return undefined
  }
  if (manifestText === undefined) {
    problems.push('manifest.json is missing')
    return undefined
  }
  const catalog = JSON.parse(catalogText) as { providers: ProviderRow[] }
  const manifest = JSON.parse(manifestText) as {
    nodes: ManifestNode[]
    capabilities?: { llm?: { providers?: string[] } }
  }
  if (manifest.nodes.length !== catalog.providers.length) {
    problems.push(
      `manifest lists ${manifest.nodes.length} nodes, catalog has ${catalog.providers.length} providers`,
    )
  }
  const expectedIds = catalog.providers.map((provider) => nodeIdFor(provider.id))
  for (const [index, node] of manifest.nodes.entries()) {
    if (node.id !== expectedIds[index]) {
      problems.push(`manifest node ${index} is "${node.id}", expected "${expectedIds[index]}"`)
      break
    }
  }
  const supported = catalog.providers
    .filter((provider) => provider.transport === 'openai-completions')
    .map((provider) => provider.id)
  const declared = manifest.capabilities?.llm?.providers ?? []
  if (declared.join(',') !== supported.join(',')) {
    problems.push('capabilities.llm.providers does not match the supported providers')
  }
  return catalog.providers
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const hasSource =
    options.fromUrl !== undefined || options.fromJson !== undefined || options.fromDir !== undefined

  if (!hasSource && !options.check) {
    printUsage()
    return 2
  }

  const problems: string[] = []
  let providers: ProviderRow[] | undefined

  if (hasSource) {
    const source = await readSource(options)
    const overrides = readOverrides(options.overridesFile)
    providers = buildProviders(source.payload, overrides)
    const files = generate(source, providers)
    const catalogFile = files.find((file) => file.path === join('data', 'catalog.json'))
    if (catalogFile !== undefined && catalogFile.content.length > CATALOG_SOFT_LIMIT_BYTES) {
      process.stderr.write(
        `warning: data/catalog.json is ${catalogFile.content.length} bytes, over the ${CATALOG_SOFT_LIMIT_BYTES}-byte budget; drop modalities to shrink it\n`,
      )
    }
    if (options.check) {
      for (const file of files) {
        const committed = readCommitted(options.outDir, file.path)
        if (committed === undefined) {
          problems.push(`${file.path} is missing`)
        } else if (committed !== file.content) {
          problems.push(`${file.path} does not match a fresh generation`)
        }
      }
    } else {
      writeFiles(options.outDir, files)
    }
  }

  const catalogProviders = checkCommitted(options.outDir, problems)
  const effective = providers ?? catalogProviders
  if (effective !== undefined) {
    process.stdout.write(`${formatStats(statsOf(effective))}\n`)
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`error: ${problem}\n`)
    return 1
  }
  if (options.check) process.stdout.write('catalog, manifest and nodes are consistent\n')
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${message}\n\n`)
      printUsage()
      process.exitCode = 2
      return
    }
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  },
)
