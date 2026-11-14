#!/usr/bin/env node
/**
 * Merges supported providers into a `z1.config.json`.
 *
 * A provider node routes through `ctx.llm.chat`, so the host has to know the
 * provider: its protocol, the environment variable holding the key, and the API
 * root. This script writes exactly that entry, leaving every other key and every
 * provider it was not asked about untouched.
 *
 * It never reads or prints a key value: `env[0]` from the catalog is only the
 * *name* of the variable.
 *
 * Usage:
 *   node scripts/install-providers.ts [--file <path>] [--only a,b,c | --all] [--dry-run]
 *
 * @module z1-providers/scripts/install-providers
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILE = './z1.config.json'

const USAGE = [
  'usage: node scripts/install-providers.ts [options]',
  '',
  '  --file <path>   config to update (default ./z1.config.json)',
  '  --only a,b,c    install exactly these provider ids',
  '  --all           install every supported provider (the default)',
  '  --dry-run       print the plan, write nothing',
  '  --help          this text',
  '',
].join('\n')

interface CatalogProvider {
  id: string
  name: string
  env: string[]
  api?: string
  transport: 'openai-completions' | 'unsupported'
  reason?: string
  protocol: string
}

interface ProviderEntry {
  id: string
  protocol?: string
  envKey?: string
  baseURL?: string
  [key: string]: unknown
}

interface Options {
  file: string
  only: string[] | undefined
  all: boolean
  dryRun: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = { file: DEFAULT_FILE, only: undefined, all: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    const value = (): string => {
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === '--file') {
      options.file = value()
    } else if (arg === '--only') {
      const list = value()
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      if (list.length === 0) throw new UsageError('--only needs at least one provider id')
      options.only = list
    } else if (arg === '--all') {
      options.all = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else {
      throw new UsageError(`unknown argument "${arg}"`)
    }
  }
  if (options.all && options.only !== undefined) {
    throw new UsageError('pass --all or --only, not both')
  }
  return options
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCatalog(): CatalogProvider[] {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8'))
  if (!isRecord(raw) || !Array.isArray(raw['providers'])) {
    throw new Error('data/catalog.json: expected { "providers": [...] }')
  }
  return raw['providers'] as CatalogProvider[]
}

/** The config document, or an empty object when the file does not exist yet. */
function readConfig(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw error
  }
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`${file}: expected a JSON object`)
  return parsed
}

/** Placeholder in an upstream base URL, e.g. `${NEON_AI_GATEWAY_BASE_URL}`. */
const TEMPLATE_VAR = /\$\{([A-Z][A-Z0-9_]*)\}/g

/**
 * Resolve placeholders from the environment.
 *
 * models.dev publishes five providers whose API root contains an account id or
 * a gateway URL. Writing `${NAME}` into a config would produce a provider that
 * fails at the first request with an unhelpful URL error, so the placeholder is
 * filled here or the provider is skipped with the names it still needs.
 */
function expandBaseUrl(
  api: string,
  env: NodeJS.ProcessEnv,
): { baseURL: string } | { missing: string[] } {
  const missing: string[] = []
  const baseURL = api.replace(TEMPLATE_VAR, (_match, name: string) => {
    const value = env[name]
    if (value === undefined || value.trim() === '') {
      missing.push(name)
      return ''
    }
    return value.trim()
  })
  if (missing.length > 0) return { missing }
  return { baseURL }
}

function providerEntry(provider: CatalogProvider, env: NodeJS.ProcessEnv): ProviderEntry {
  const envKey = provider.env[0]
  if (envKey === undefined) {
    throw new Error(`provider "${provider.id}" declares no environment variable`)
  }
  if (provider.api === undefined) {
    throw new Error(`provider "${provider.id}" has no API base URL`)
  }
  const expanded = expandBaseUrl(provider.api, env)
  if ('missing' in expanded) {
    throw new Error(
      `provider "${provider.id}" needs ${expanded.missing.join(', ')} to resolve its base URL; set it and run again`,
    )
  }
  return {
    id: provider.id,
    protocol: 'openai-completions',
    envKey,
    baseURL: expanded.baseURL,
  }
}

function select(providers: CatalogProvider[], options: Options): CatalogProvider[] {
  const supported = new Map(
    providers
      .filter((provider) => provider.transport === 'openai-completions')
      .map((provider) => [provider.id, provider]),
  )
  if (options.only === undefined) return [...supported.values()]

  const chosen: CatalogProvider[] = []
  const problems: string[] = []
  for (const id of options.only) {
    const provider = supported.get(id)
    if (provider !== undefined) {
      chosen.push(provider)
      continue
    }
    const known = providers.find((candidate) => candidate.id === id)
    if (known === undefined) {
      problems.push(`"${id}" is not a models.dev provider (see data/catalog.json)`)
    } else {
      problems.push(
        `"${id}" is unsupported: ${known.reason ?? 'unknown reason'} (speaks ${known.protocol})`,
      )
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return chosen
}

interface Plan {
  config: Record<string, unknown>
  lines: string[]
  added: number
  updated: number
  unchanged: number
}

function plan(
  config: Record<string, unknown>,
  chosen: CatalogProvider[],
  env: NodeJS.ProcessEnv,
  skipped: { id: string; missing: string[] }[],
): Plan {
  const existing = Array.isArray(config['providers'])
    ? (config['providers'] as unknown[]).filter(isRecord).map((entry) => entry as ProviderEntry)
    : []
  const next = existing.map((entry) => ({ ...entry }))
  const indexById = new Map<string, number>()
  next.forEach((entry, index) => {
    if (typeof entry.id === 'string') indexById.set(entry.id, index)
  })

  const lines: string[] = []
  let added = 0
  let updated = 0
  let unchanged = 0

  for (const provider of chosen) {
    const expanded = provider.api === undefined ? undefined : expandBaseUrl(provider.api, env)
    if (expanded !== undefined && 'missing' in expanded) {
      // `--all` skips a provider it cannot resolve; `--only` reports it by name
      // from `select`, so this path is only reached for the bulk install.
      skipped.push({ id: provider.id, missing: expanded.missing })
      continue
    }
    const wanted = providerEntry(provider, env)
    const index = indexById.get(provider.id)
    if (index === undefined) {
      lines.push(`+ ${provider.id} (${wanted.protocol}, ${wanted.envKey}, ${wanted.baseURL})`)
      indexById.set(provider.id, next.length)
      next.push(wanted)
      added += 1
      continue
    }
    const current = next[index] as ProviderEntry
    // Keep what the user added (headers, comments-as-keys) and update the four
    // fields this script owns.
    const merged: ProviderEntry = { ...current, ...wanted }
    const changed = JSON.stringify(current) !== JSON.stringify(merged)
    if (changed) {
      const differences = (['protocol', 'envKey', 'baseURL'] as const).filter(
        (key) => current[key] !== merged[key],
      )
      const detail =
        differences.length === 0
          ? 'field order'
          : differences.map((key) => `${key} ${String(current[key])} -> ${String(merged[key])}`).join(', ')
      lines.push(`~ ${provider.id} (${detail})`)
      next[index] = merged
      updated += 1
    } else {
      lines.push(`= ${provider.id} (already configured)`)
      unchanged += 1
    }
  }

  const result: Record<string, unknown> = { ...config, providers: next }
  return { config: result, lines, added, updated, unchanged }
}

function main(): number {
  const options = parseArgs(process.argv.slice(2))
  const providers = readCatalog()
  const chosen = select(providers, options)
  const file = resolve(options.file)
  const existing = readConfig(file)
  const skipped: { id: string; missing: string[] }[] = []
  const result = plan(existing, chosen, process.env, skipped)
  if (options.only !== undefined && skipped.length > 0) {
    // An explicit request must not be silently dropped.
    const first = skipped[0]
    throw new Error(
      `provider "${String(first?.id)}" needs ${(first?.missing ?? []).join(', ')} to resolve its base URL; set it and run again`,
    )
  }

  for (const line of result.lines) process.stdout.write(`${line}\n`)
  for (const entry of skipped) {
    process.stdout.write(`- ${entry.id} (needs ${entry.missing.join(', ')}; skipped)\n`)
  }
  const summary = `${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged${skipped.length === 0 ? '' : `, ${String(skipped.length)} skipped`}`
  if (options.dryRun) {
    process.stdout.write(`dry run: ${summary}; ${file} not written\n`)
    return 0
  }
  writeFileSync(file, `${JSON.stringify(result.config, null, 2)}\n`)
  process.stdout.write(`wrote ${file} (${summary})\n`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`error: ${message}\n`)
  if (error instanceof UsageError) {
    process.stderr.write(`\n${USAGE}`)
    process.exitCode = 2
  } else {
    process.exitCode = 1
  }
}
