import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PathsConfig } from '../config.js'
import { expandHome } from '../config.js'
import { statFile } from '../core/fs.js'

export class AccessError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'AccessError'
    this.code = code
  }
}

const BLOCKED_PREFIXES: string[] = process.platform === 'win32'
  ? ['C:\\Windows\\System32', 'C:\\Windows\\SysWOW64']
  : ['/etc', '/private/etc', '/dev', '/proc', '/sys', '/System', '/bin', '/sbin', '/usr/bin', '/usr/sbin']

export interface ResolvedMediaFile {
  path: string
  size: number
  extension: string
  modifiedAt: string
}

export async function resolveMediaFile(
  input: string,
  config: PathsConfig,
  cwd = process.cwd(),
): Promise<ResolvedMediaFile> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AccessError('path must be a non-empty string', 'INVALID_PATH')
  }
  const expanded = expandHome(input.trim())
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch {
    throw new AccessError(`本地文件不存在或不可访问：${candidate}`, 'INPUT_NOT_FOUND')
  }
  assertNotBlocked(canonical)
  const info = await statFile(canonical)
  if (!info || !info.isFile()) {
    throw new AccessError(`不是普通文件：${canonical}`, 'NOT_A_FILE')
  }
  if (info.size > config.maxFileSizeBytes) {
    throw new AccessError(
      `文件超过大小上限（${info.size} > ${config.maxFileSizeBytes} 字节）。可在 paths.maxFileSizeBytes 中调整。`,
      'FILE_TOO_LARGE',
    )
  }
  const extension = extname(canonical).toLowerCase()
  if (!config.allowedExtensions.includes(extension)) {
    throw new AccessError(
      `不支持的媒体扩展名：${extension || '(无)'}。支持：${config.allowedExtensions.join(', ')}`,
      'UNSUPPORTED_MEDIA',
    )
  }
  if (config.mode === 'roots') {
    const within = config.allowedRoots.some(root => isWithin(canonical, root))
    if (!within) {
      throw new AccessError(
        `文件不在 paths.allowedRoots 允许的目录内：${canonical}`,
        'PATH_OUTSIDE_ALLOWED_ROOTS',
      )
    }
  }
  return {
    path: canonical,
    size: info.size,
    extension,
    modifiedAt: info.mtime.toISOString(),
  }
}

export async function resolveOutputPath(
  input: string,
  config: PathsConfig,
  dataDir: string,
  cwd = process.cwd(),
): Promise<string> {
  const expanded = expandHome(input.trim())
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  assertNotBlocked(candidate)
  if (config.mode === 'roots') {
    const within = config.allowedRoots.some(root => isWithin(candidate, root)) || isWithin(candidate, dataDir)
    if (!within) {
      throw new AccessError(
        `输出路径不在 paths.allowedRoots 允许的目录内：${candidate}`,
        'PATH_OUTSIDE_ALLOWED_ROOTS',
      )
    }
  }
  return candidate
}

export function isWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertNotBlocked(path: string): void {
  for (const prefix of BLOCKED_PREFIXES) {
    if (isWithin(path, prefix)) {
      throw new AccessError(`拒绝访问受保护的系统目录：${path}`, 'PROTECTED_PATH')
    }
  }
}
