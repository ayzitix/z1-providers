/**
 * The installer's pure decisions: which env var is the credential, which
 * placeholder may be resolved, and which base URL may be written.
 *
 * These are the three places where data from models.dev can turn into something
 * dangerous (a secret copied into a config, prompts sent to another host), so
 * they are tested directly as well as through the CLI.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { expandBaseUrl, pickEnvKey, validateBaseUrl } from '../scripts/install-providers.ts'

test('the credential is picked by name, not by position', () => {
  assert.deepEqual(pickEnvKey(['DATABRICKS_HOST', 'DATABRICKS_TOKEN']), {
    envKey: 'DATABRICKS_TOKEN',
  })
  assert.deepEqual(pickEnvKey(['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN']), {
    envKey: 'NEON_AI_GATEWAY_TOKEN',
  })
  assert.deepEqual(pickEnvKey(['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_CORTEX_PAT']), {
    envKey: 'SNOWFLAKE_CORTEX_PAT',
  })
  assert.deepEqual(pickEnvKey(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY']), {
    envKey: 'CLOUDFLARE_API_KEY',
  })
  // Key first is fine too: `INFOMANIAK_PRODUCT_ID` is not a credential.
  assert.deepEqual(pickEnvKey(['INFOMANIAK_API_KEY', 'INFOMANIAK_PRODUCT_ID']), {
    envKey: 'INFOMANIAK_API_KEY',
  })
})

test('a single variable is used as-is, an ambiguous pair is refused', () => {
  assert.deepEqual(pickEnvKey(['GROQ_API_KEY']), { envKey: 'GROQ_API_KEY' })
  const ambiguous = pickEnvKey(['SOME_HOST', 'SOME_REGION'])
  assert.ok('problem' in ambiguous)
  assert.match(ambiguous.problem, /cannot tell which of SOME_HOST, SOME_REGION/)
})

test('only the five approved placeholders are resolved', () => {
  const env = {
    DATABRICKS_HOST: 'dbx.example',
    AWS_SECRET_ACCESS_KEY: 'super-secret',
  }
  assert.deepEqual(expandBaseUrl('https://${DATABRICKS_HOST}/ai/v1', env), {
    baseURL: 'https://dbx.example/ai/v1',
  })

  // Data from upstream must not be able to copy an arbitrary env value into a
  // config, and from there into a request.
  const refused = expandBaseUrl('https://${AWS_SECRET_ACCESS_KEY}.evil/v1', env)
  assert.ok('problem' in refused)
  assert.match(refused.problem, /refuses placeholder \$\{AWS_SECRET_ACCESS_KEY\}/)
})

test('an approved placeholder that is unset is a problem, not an empty string', () => {
  const missing = expandBaseUrl('https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/v1', {})
  assert.ok('problem' in missing)
  assert.match(missing.problem, /needs SNOWFLAKE_ACCOUNT/)
})

test('a base URL must be https, or http only on loopback', () => {
  assert.equal(validateBaseUrl('https://api.example/v1'), undefined)
  assert.equal(validateBaseUrl('http://127.0.0.1:1234/v1'), undefined)
  assert.equal(validateBaseUrl('http://localhost:8080/v1'), undefined)
  assert.match(validateBaseUrl('http://api.example/v1') ?? '', /refuses http/)
  assert.match(validateBaseUrl('https://user:pw@api.example/v1') ?? '', /embedded/)
  assert.match(validateBaseUrl('https://${ACCOUNT}.example/v1') ?? '', /unresolved/)
  assert.match(validateBaseUrl('not-a-url') ?? '', /not a valid URL/)
})
