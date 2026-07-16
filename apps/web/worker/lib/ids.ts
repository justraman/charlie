// UUIDv7: 48-bit big-endian millisecond timestamp + 74 random bits, with the
// version/variant nibbles set. Lexicographic string order matches creation
// order, which is what our TEXT primary keys rely on (see docs/DATA_MODEL.md).
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const ts = Math.floor(now)
  // 48-bit timestamp across bytes 0..5 (big-endian).
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff

  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  // Variant (10xx) in the high bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex: string[] = []
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
