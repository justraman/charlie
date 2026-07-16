// Coarse fixed-window rate limiting backed by KV. Intentionally simple: it
// caps abusive bursts, not a precise quota. Fails OPEN on KV errors so a KV
// hiccup never locks users out. Per-run high-frequency counters use Durable
// Objects instead (Phase 3), not this.

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

export async function rateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec)
  const k = `rl:${key}:${bucket}`
  try {
    const current = Number((await kv.get(k)) ?? '0')
    if (current >= limit) return { allowed: false, remaining: 0 }
    // Expire a little after the window closes; not atomic, acceptable for coarse limits.
    await kv.put(k, String(current + 1), { expirationTtl: windowSec + 5 })
    return { allowed: true, remaining: Math.max(0, limit - current - 1) }
  } catch {
    return { allowed: true, remaining: limit }
  }
}
