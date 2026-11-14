/**
 * Shared test helpers: a scratch directory under the approved `/tmp/opencode`
 * (falling back to os.tmpdir) and a runner for the CLI scripts.
 *
 * @module z1-providers/tests/helpers
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix: string): string {
  const base = process.env['Z1_TEST_TMP'] ?? '/tmp/opencode'
  try {
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, `${prefix}-`))
  } catch {
    return mkdtempSync(join(tmpdir(), `${prefix}-`))
  }
}

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}
