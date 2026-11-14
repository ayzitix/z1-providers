#!/usr/bin/env node
/**
 * `node scripts/models.ts <provider>` — what a provider serves right now.
 *
 * The inspection tool lives here, next to the address table it uses, not in the
 * z1 CLI: asking one provider what it has is a provider concern, and the answer
 * depends on that provider's path, query and body shape.
 *
 * It reads the same `z1.config.json` a run reads, resolves the key from the
 * provider's env var, and prints ids. It never writes anything.
 *
 * Usage:
 *   node scripts/models.ts <provider> [--config <file>] [--json]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { allProviders, providerById } from '../lib/catalog.js'
import { discoverModels, endpointFor, loadEndpoints } from '../lib/models.js'

const USAGE = [
  'usage: node scripts/models.ts <provider> [options]',
  '',
  '  --config <path>  z1.config.json to read (default ./z1.config.json)',
  '  --json           print { provider, baseURL, models } as JSON',
  '  --all            every provider that has a base URL (skips failures)',
  '  --help           this text',
  '',
].join('\n')

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { provider: undefined, config: './z1.config.json', json: false, all: false }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      const value = argv[index + 1]
      if (value === undefined) fail('--config needs a value')
      options.config = value
      index += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--all') {
      options.all = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else if (arg.startsWith('-')) {
      fail(`unknown option "${arg}"\n\n${USAGE}`)
    } else {
      positionals.push(arg)
    }
  }
  options.provider = positionals[0]
  if (options.provider === undefined && !options.all) fail(`provider is required\n\n${USAGE}`)
  return options
}

function readConfigured(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (text.trim() === '') return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed.providers) ? parsed.providers : []
}

/** Everything a `ctx.llm.get` would do, without a runtime. */
function makeContext() {
  return {
    llm: {
      async get({ path, query }, providerConfig) {
        let url = `${providerConfig.baseURL.replace(/\/+$/, '')}${path}`
        if (query !== undefined) {
          const search = new URLSearchParams(query).toString()
          if (search.length > 0) url += `${url.includes('?') ? '&' : '?'}${search}`
        }
        const key = providerConfig.envKey === undefined ? undefined : process.env[providerConfig.envKey]
        if (providerConfig.envKey !== undefined && (key === undefined || key === '')) {
          throw new Error(`missing ${providerConfig.envKey}`)
        }
        const response = await fetch(url, {
          headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
        })
        return {
          status: response.status,
          ok: response.ok,
          body: await response.text(),
          truncated: false,
        }
      },
    },
  }
}

/**
 * Bind the provider id to its connection, then hand `discoverModels` a context
 * whose `get` already knows that connection.
 */
function contextFor(providerConfig) {
  const base = makeContext()
  return {
    llm: {
      get: (request) => base.llm.get(request, providerConfig),
    },
  }
}

async function resolveConnection(providerId, configured) {
  const entry = configured.find((provider) => provider.id === providerId)
  if (entry !== undefined) {
    if (typeof entry.baseURL !== 'string') fail(`provider "${providerId}" in the config has no baseURL`)
    return { baseURL: entry.baseURL, envKey: entry.envKey }
  }
  const catalogProvider = providerById(providerId)
  if (catalogProvider === undefined) {
    fail(`unknown provider "${providerId}"; run without a name or see data/catalog.json`)
  }
  if (catalogProvider.transport !== 'openai-completions') {
    fail(`provider "${providerId}" is unsupported: ${catalogProvider.reason ?? catalogProvider.protocol}`)
  }
  const baseURL = catalogProvider.api
  if (baseURL === undefined) {
    fail(`provider "${providerId}" has no base URL; add one to data/overrides.json`)
  }
  return { baseURL, envKey: catalogProvider.env[0] }
}

async function listOne(providerId, configured) {
  const connection = await resolveConnection(providerId, configured)
  const { ids, endpoint } = await discoverModels(contextFor(connection), providerId, {
    endpoints: loadEndpoints(),
  })
  return { provider: providerId, baseURL: connection.baseURL, endpoint: endpointFor(providerId), models: ids }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const configured = readConfigured(resolve(options.config))

  if (options.all) {
    const targets = configured.length > 0
      ? configured.map((provider) => provider.id)
      : allProviders()
          .filter((provider) => provider.transport === 'openai-completions')
          .map((provider) => provider.id)
    const results = []
    for (const providerId of targets) {
      try {
        results.push(await listOne(providerId, configured))
      } catch (error) {
        process.stderr.write(`${providerId}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (options.json) process.stdout.write(`${JSON.stringify({ providers: results }, null, 2)}\n`)
    else {
      for (const result of results) {
        process.stdout.write(`${result.provider} (${result.models.length})\n`)
        for (const id of result.models) process.stdout.write(`  ${id}\n`)
      }
    }
    return
  }

  const result = await listOne(options.provider, configured)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${result.provider} · ${result.baseURL}${result.endpoint.path}\n`)
  for (const id of result.models) process.stdout.write(`  ${id}\n`)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
