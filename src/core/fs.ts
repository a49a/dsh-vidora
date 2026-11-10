import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

export class StorageError extends Error {
  readonly code: string

  constructor(message: string, code = 'STORAGE_ERROR') {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function statFile(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/**
 * Replace a file atomically. The fresh sibling is created with 0600, synced,
 * then renamed over the target. The rename never follows a planted symlink.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path))
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  let delay = 20
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = process.platform === 'win32' && (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM')
      if (!transient || attempt >= 7) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, delay))
      delay = Math.min(delay * 2, 200)
    }
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJsonFile(path: string, maxBytes = 256 * 1024 * 1024): Promise<unknown> {
  const info = await statFile(path)
  if (!info) throw new StorageError(`File not found: ${path}`, 'NOT_FOUND')
  if (!info.isFile()) throw new StorageError(`Not a regular file: ${path}`, 'NOT_A_FILE')
  if (info.size > maxBytes) throw new StorageError(`JSON file is too large: ${path}`, 'FILE_TOO_LARGE')
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new StorageError(`Invalid JSON: ${path}`, 'INVALID_JSON')
  }
}

export function safeFileBaseName(input: string): string {
  const base = basename(input, extname(input))
  const cleaned = base
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return cleaned || 'vidora'
}

export function resolveUserPath(base: string, input: string): string {
  return resolve(base, input)
}
