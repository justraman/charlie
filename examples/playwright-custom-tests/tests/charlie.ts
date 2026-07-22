// Tiny helper for reading Charlie-provided secrets in a test.
//
// Charlie injects each environment secret as an env var named
// `CHARLIE_SECRET_<NAME>` (never sent to any third party, only into this
// process on the compute plane). This helper just reads them with a clear
// error when a required one is missing.

export function secret(name: string): string {
  const value = process.env[`CHARLIE_SECRET_${name}`]
  if (value === undefined || value === '') {
    throw new Error(
      `Missing secret "${name}". Add it to the environment in Charlie, or set ` +
        `CHARLIE_SECRET_${name} locally to run this test outside Charlie.`,
    )
  }
  return value
}

/** Optional secret — returns undefined instead of throwing. */
export function optionalSecret(name: string): string | undefined {
  return process.env[`CHARLIE_SECRET_${name}`] || undefined
}
