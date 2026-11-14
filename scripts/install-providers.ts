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
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  // A BOM is legal in a file an editor wrote, and JSON.parse rejects it.
  const withoutBom = text.replace(/^\uFEFF/, '')
  if (withoutBom.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutBom)
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`${file}: expected a JSON object`)

  // A wrong shape is not ours to repair: silently replacing a `providers`
  // object, or dropping a non-object entry, deletes configuration the user wrote.
  const providers = parsed['providers']
  if (providers !== undefined) {
    if (!Array.isArray(providers)) {
      throw new Error(`${file}: "providers" must be an array`)
    }
    const seen = new Set<string>()
    for (const [index, entry] of providers.entries()) {
      if (!isRecord(entry)) {
        throw new Error(`${file}: providers[${String(index)}] must be an object`)
      }
      const id = entry['id']
      if (typeof id !== 'string' || id === '') {
        throw new Error(`${file}: providers[${String(index)}] has no string "id"`)
      }
      if (seen.has(id)) {
        throw new Error(`${file}: providers lists "${id}" more than once`)
      }
      seen.add(id)
    }
  }
  return parsed
}

/**
 * Placeholders a config write may resolve.
 *
 * A template is data from models.dev, so an unlisted name is refused: otherwise
 * a bad upstream row (`https://${AWS_SECRET_ACCESS_KEY}.evil/v1`) would copy a
 * secret into a plaintext config and send prompts to that host.
 */
const ALLOWED_TEMPLATE_VARS = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'DATABRICKS_HOST',
  'INFOMANIAK_PRODUCT_ID',
  'NEON_AI_GATEWAY_BASE_URL',
  'SNOWFLAKE_ACCOUNT',
])

const TEMPLATE_VAR = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** A name that looks like the credential rather than the host or account. */
const CREDENTIAL_ENV = /(TOKEN|KEY|PAT|SECRET|PASSWORD)/i

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::|\/)/i

interface Problem {
  problem: string
}

/**
 * Resolve the five known placeholders from the environment.
 *
 * A placeholder that is not approved, or is unset, becomes a problem the caller
 * reports: writing `${NAME}` into a config would fail at the first request with
 * an unhelpful URL error.
 */
export function expandBaseUrl(api: string, env: NodeJS.ProcessEnv): { baseURL: string } | Problem {
  const problems: string[] = []
  const baseURL = api.replace(TEMPLATE_VAR, (_match, name: string) => {
    if (!ALLOWED_TEMPLATE_VARS.has(name)) {
      problems.push(`refuses placeholder \${${name}} (not an approved variable)`)
      return ''
    }
    const value = env[name]
    if (value === undefined || value.trim() === '') {
      problems.push(`needs ${name}`)
      return ''
    }
    return value.trim()
  })
  if (problems.length > 0) return { problem: [...new Set(problems)].join('; ') }
  return { baseURL }
}

/** An https root, or plain http only for a loopback address. */
export function validateBaseUrl(baseURL: string): string | undefined {
  if (baseURL.includes('${')) return `unresolved placeholder in ${baseURL}`
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    return `not a valid URL: ${baseURL}`
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `refuses credentials embedded in the base URL: ${baseURL}`
  }
  if (parsed.protocol === 'https:') return undefined
  if (parsed.protocol === 'http:' && LOOPBACK.test(baseURL)) return undefined
  return `refuses ${parsed.protocol} for a non-loopback host: ${baseURL}`
}

/**
 * The variable that actually holds the token.
 *
 * Several providers declare the host or account first (`DATABRICKS_HOST`,
 * `NEON_AI_GATEWAY_BASE_URL`). Taking `env[0]` would send that value as a bearer
 * token and never read the real one, so pick by name and refuse to guess.
 */
export function pickEnvKey(names: readonly string[]): { envKey: string } | Problem {
  const named = names.find((name) => CREDENTIAL_ENV.test(name))
  if (named !== undefined) return { envKey: named }
  const only = names[0]
  if (names.length === 1 && only !== undefined) return { envKey: only }
  if (names.length === 0) return { problem: 'declares no environment variable' }
  return {
    problem: `cannot tell which of ${names.join(', ')} is the credential; add an envKey to data/catalog.json`,
  }
}

interface Prepared {
  id: string
  entry?: ProviderEntry
  problem?: string
}

function prepare(provider: CatalogProvider, env: NodeJS.ProcessEnv): Prepared {
  if (provider.api === undefined) return { id: provider.id, problem: 'no API base URL' }

  const expanded = expandBaseUrl(provider.api, env)
  if ('problem' in expanded) return { id: provider.id, problem: expanded.problem }

  const invalid = validateBaseUrl(expanded.baseURL)
  if (invalid !== undefined) return { id: provider.id, problem: invalid }

  const key = pickEnvKey(provider.env)
  if ('problem' in key) return { id: provider.id, problem: key.problem }

  return {
    id: provider.id,
    entry: {
      id: provider.id,
      protocol: 'openai-completions',
      envKey: key.envKey,
      baseURL: expanded.baseURL,
    },
  }
}

function select(providers: CatalogProvider[], options: Options): CatalogProvider[] {
  const supported = new Map(
    providers
      .filter((provider) => provider.transport === 'openai-completions')
      .map((provider) => [provider.id, provider]),
  )
  // A loopback root points at whatever listens on this machine. `--all` must
  // not add one; the caller reports it as skipped. `--only` still can, because
  // that is an explicit request.
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
  prepared: readonly Prepared[],
  skipped: { id: string; problem: string }[],
): Plan {
  const existing = (config['providers'] ?? []) as ProviderEntry[]
  const next = existing.map((entry) => ({ ...entry }))
  const indexById = new Map<string, number>()
  next.forEach((entry, index) => indexById.set(entry.id, index))

  const lines: string[] = []
  let added = 0
  let updated = 0
  let unchanged = 0

  for (const item of prepared) {
    if (item.entry === undefined) {
      skipped.push({ id: item.id, problem: item.problem ?? 'unknown problem' })
      continue
    }
    const wanted = item.entry
    const index = indexById.get(wanted.id)
    if (index === undefined) {
      lines.push(`+ ${wanted.id} (${wanted.protocol}, ${wanted.envKey}, ${wanted.baseURL})`)
      indexById.set(wanted.id, next.length)
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
      lines.push(`~ ${wanted.id} (${detail})`)
      next[index] = merged
      updated += 1
    } else {
      lines.push(`= ${wanted.id} (already configured)`)
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
  const prepared = chosen.map((provider) =>
    options.only === undefined && LOOPBACK.test(provider.api ?? '')
      ? {
          id: provider.id,
          problem: 'loopback base URL; install it explicitly with --only',
        }
      : prepare(provider, process.env),
  )
  const skipped: { id: string; problem: string }[] = []
  const result = plan(existing, prepared, skipped)
  if (options.only !== undefined && skipped.length > 0) {
    // An explicit request must not be silently dropped.
    const first = skipped[0]
    throw new Error(`provider "${String(first?.id)}": ${String(first?.problem)}`)
  }

  for (const line of result.lines) process.stdout.write(`${line}\n`)
  for (const entry of skipped) {
    process.stdout.write(`- ${entry.id} (${entry.problem}; skipped)\n`)
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
