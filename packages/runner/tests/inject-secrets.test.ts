import { describe, expect, test } from 'bun:test'
import { injectSecrets, RESERVED_ENV_NAMES } from '../src/playwright-project'

describe('injectSecrets', () => {
  test('exports each secret under its own name — no renaming', () => {
    const env: Record<string, string | undefined> = {}
    const skipped = injectSecrets(env, { TEST_EMAIL: 'qa@example.com', TEST_PASSWORD: 'hunter2' })

    expect(env.TEST_EMAIL).toBe('qa@example.com')
    expect(env.TEST_PASSWORD).toBe('hunter2')
    expect(skipped).toEqual([])
  })

  test('also exports the prefixed form, so existing repos keep working', () => {
    const env: Record<string, string | undefined> = {}
    injectSecrets(env, { TEST_EMAIL: 'qa@example.com' })

    expect(env.CHARLIE_SECRET_TEST_EMAIL).toBe('qa@example.com')
  })

  test('a reserved name never overwrites the real variable', () => {
    // PATH is the one that matters most: clobbering it breaks the whole run.
    const env: Record<string, string | undefined> = {
      PATH: '/usr/local/bin:/usr/bin',
      CHARLIE_BASE_URL: 'https://staging.example.com',
    }
    const skipped = injectSecrets(env, { PATH: '/evil', CHARLIE_BASE_URL: 'https://evil.test' })

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.CHARLIE_BASE_URL).toBe('https://staging.example.com')
    expect(skipped.sort()).toEqual(['CHARLIE_BASE_URL', 'PATH'])
  })

  test('a skipped secret is still reachable via the prefixed form', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    injectSecrets(env, { PATH: 'still-needed' })

    expect(env.CHARLIE_SECRET_PATH).toBe('still-needed')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('every reserved name is refused', () => {
    const secrets = Object.fromEntries([...RESERVED_ENV_NAMES].map((n) => [n, 'x']))
    const skipped = injectSecrets({}, secrets)

    expect(skipped.sort()).toEqual([...RESERVED_ENV_NAMES].sort())
  })

  test('names that are not legal env var names are skipped', () => {
    const env: Record<string, string | undefined> = {}
    const skipped = injectSecrets(env, {
      'has-dash': 'a',
      'has space': 'b',
      'has=equals': 'c',
      '1leading-digit': 'd',
      '': 'e',
      OK_NAME: 'f',
    })

    expect(skipped.sort()).toEqual(['', '1leading-digit', 'has space', 'has-dash', 'has=equals'])
    expect(env.OK_NAME).toBe('f')
  })

  test('an empty secret map changes nothing', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    expect(injectSecrets(env, {})).toEqual([])
    expect(Object.keys(env)).toEqual(['PATH'])
  })
})
