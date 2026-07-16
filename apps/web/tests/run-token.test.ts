import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { RunTokenError, signRunToken, verifyRunToken } from '../worker/lib/run-token'

const secret = new TextEncoder().encode('test-run-token-secret-value-0001')
const other = new TextEncoder().encode('a-different-secret-value-00000002')

describe('run token', () => {
  test('sign then verify returns the run id', async () => {
    const token = await signRunToken('run_abc', secret)
    expect(await verifyRunToken(token, secret)).toBe('run_abc')
  })

  test('rejects a token signed with a different secret', async () => {
    const token = await signRunToken('run_abc', secret)
    await expect(verifyRunToken(token, other)).rejects.toThrow(RunTokenError)
  })

  test('rejects an expired token', async () => {
    const token = await signRunToken('run_abc', secret, -10)
    await expect(verifyRunToken(token, secret)).rejects.toThrow(/invalid run token/)
  })

  test('rejects a tampered token', async () => {
    const token = await signRunToken('run_abc', secret)
    const tampered = `${token.slice(0, -3)}aaa`
    await expect(verifyRunToken(tampered, secret)).rejects.toThrow(RunTokenError)
  })

  test('rejects a JWT that is not scoped as a run token', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const notRun = await new SignJWT({ scope: 'other' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('run_abc')
      .setExpirationTime(nowSec + 600)
      .sign(secret)
    await expect(verifyRunToken(notRun, secret)).rejects.toThrow(/not a run token/)
  })
})
