import { createHash } from 'node:crypto'

/** JSON stringify with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item !== undefined) out[key] = sortValue(item)
    }
    return out
  }
  return value
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function shortHash(input: string, length = 16): string {
  return sha256Hex(input).slice(0, length)
}
