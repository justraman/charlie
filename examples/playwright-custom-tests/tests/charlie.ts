// Tiny helper for reading Charlie-provided secrets in a test.
//
// Charlie injects each environment secret as an env var under its own name, so
// `secret('TEST_EMAIL')` reads `process.env.TEST_EMAIL` — the same variable your
// repo would use outside Charlie. The prefixed `CHARLIE_SECRET_TEST_EMAIL` is
// also set, and is the fallback here because it's how a secret whose name
// collides with a reserved var (PATH, CHARLIE_BASE_URL, …) still gets through.
//
// Secrets are never sent to any third party — they're decrypted on the compute
// plane and exist only in this process, for the duration of the run.
//
// You don't need this helper at all: `process.env.TEST_EMAIL` works directly.
// It exists to give a clear error when a required secret is missing.

function read(name: string): string | undefined {
  return process.env[name] || process.env[`CHARLIE_SECRET_${name}`] || undefined
}

export function secret(name: string): string {
  const value = read(name)
  if (value === undefined || value === '') {
    throw new Error(
      `Missing secret "${name}". Add it to the environment in Charlie, or set ` +
        `${name} locally to run this test outside Charlie.`,
    )
  }
  return value
}

/** Optional secret — returns undefined instead of throwing. */
export function optionalSecret(name: string): string | undefined {
  return read(name)
}
