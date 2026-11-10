import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type LlmMode = 'off' | 'ollama' | 'openai' | 'harness'
export type DevicePreference = 'auto' | 'cpu' | 'mps' | 'cuda'
export type DtypePreference = 'auto' | 'float16' | 'bfloat16' | 'float32'
export type PathAccessMode = 'explicit' | 'roots'

export interface VadConfig {
  thresholdDb: number | null
  minSilenceMs: number
  minSpeechMs: number
  paddingMs: number
  maxGapMs: number
  frameMs: number
}

export interface WorkerConfig {
  pythonPath: string
  workerDir: string
  autoStart: boolean
  startTimeoutMs: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  idleUnloadSeconds: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface AsrConfig {
  defaultModel: string
  modelsDir: string
  device: DevicePreference
  dtype: DtypePreference
  language: string
  align: boolean
  alignerModel: string
  maxChunkSeconds: number
  maxNewTokens: number
  vad: VadConfig
}

export interface LlmConfig {
  mode: LlmMode
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  maxContextChars: number
  maxOutputTokens: number
  temperature: number
  allowNonLoopback: boolean
  harnessProvider: string
  harnessModel: string
}

export interface PrivacyConfig {
  strictLocal: boolean
  trustedLocalProviders: string[]
  trustedLocalModels: string[]
  untrustedFileToolPolicy: 'block-data-path' | 'block-all' | 'off'
}

export interface TasksConfig {
  autoResume: boolean
  maxTaskHours: number
  progressPersistIntervalMs: number
  keepTempFiles: boolean
  cancelGraceMs: number
}

export interface PathsConfig {
  mode: PathAccessMode
  allowedRoots: string[]
  allowedExtensions: string[]
  maxFileSizeBytes: number
  maxDurationMinutes: number
}

export interface DocumentConfig {
  defaultMode: 'concise' | 'detailed' | 'transcript' | 'review'
  maxCharsPerWindow: number
  maxWindows: number
  includeFrontMatter: boolean
}

export interface DiagnosticsConfig {
  workerLogMaxBytes: number
  recentLogLines: number
}

export interface VidoraConfig {
  dataDir: string
  worker: WorkerConfig
  asr: AsrConfig
  llm: LlmConfig
  privacy: PrivacyConfig
  tasks: TasksConfig
  paths: PathsConfig
  document: DocumentConfig
  diagnostics: DiagnosticsConfig
}

const DEFAULT_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.mp4',
  '.mkv',
  '.webm',
  '.ogg',
  '.opus',
  '.aac',
  '.mov',
  '.avi',
  '.m4b',
]

export class ConfigError extends Error {
  constructor(message: string) {
    super(`vidora config: ${message}`)
    this.name = 'ConfigError'
  }
}

export function defaultDataDir(): string {
  if (process.env.VIDORA_DATA_DIR) return resolve(expandHome(process.env.VIDORA_DATA_DIR))
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Vidora')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Vidora')
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vidora')
}

export function defaultWorkerDir(): string {
  return fileURLToPath(new URL('../python-worker', import.meta.url))
}

export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

export function resolveFrom(base: string, value: string): string {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

export function normalizeConfig(input: unknown): VidoraConfig {
  const root = asObject(input, 'root')
  const dataDir = resolve(expandHome(
    optionalString(root.dataDir, 'dataDir') || defaultDataDir(),
  ))

  const worker = asObject(root.worker, 'worker')
  const asr = asObject(root.asr, 'asr')
  const vad = asObject(asr.vad, 'asr.vad')
  const llm = asObject(root.llm, 'llm')
  const privacy = asObject(root.privacy, 'privacy')
  const tasks = asObject(root.tasks, 'tasks')
  const paths = asObject(root.paths, 'paths')
  const document = asObject(root.document, 'document')
  const diagnostics = asObject(root.diagnostics, 'diagnostics')

  const mode = optionalEnum(llm.mode, 'llm.mode', ['off', 'ollama', 'openai', 'harness'] as const, 'off')
  const baseUrlDefault = mode === 'openai' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434'

  const normalized: VidoraConfig = {
    dataDir,
    worker: {
      pythonPath: expandHome(
        optionalString(worker.pythonPath, 'worker.pythonPath')
        || process.env.VIDORA_PYTHON
        || '',
      ),
      workerDir: resolveFrom(
        dirname(fileURLToPath(import.meta.url)),
        optionalString(worker.workerDir, 'worker.workerDir') || defaultWorkerDir(),
      ),
      autoStart: optionalBoolean(worker.autoStart, 'worker.autoStart', true),
      startTimeoutMs: optionalNumber(worker.startTimeoutMs, 'worker.startTimeoutMs', 30_000, 1_000, 300_000),
      requestTimeoutMs: optionalNumber(worker.requestTimeoutMs, 'worker.requestTimeoutMs', 30_000, 1_000, 600_000),
      shutdownTimeoutMs: optionalNumber(worker.shutdownTimeoutMs, 'worker.shutdownTimeoutMs', 15_000, 1_000, 120_000),
      idleUnloadSeconds: optionalNumber(worker.idleUnloadSeconds, 'worker.idleUnloadSeconds', 900, 0, 86_400),
      logLevel: optionalEnum(worker.logLevel, 'worker.logLevel', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    },
    asr: {
      defaultModel: optionalString(asr.defaultModel, 'asr.defaultModel') || 'qwen3-asr-0.6b',
      modelsDir: resolveFrom(
        dataDir,
        optionalString(asr.modelsDir, 'asr.modelsDir') || 'models',
      ),
      device: optionalEnum(asr.device, 'asr.device', ['auto', 'cpu', 'mps', 'cuda'] as const, 'auto'),
      dtype: optionalEnum(asr.dtype, 'asr.dtype', ['auto', 'float16', 'bfloat16', 'float32'] as const, 'auto'),
      language: optionalString(asr.language, 'asr.language') || 'auto',
      align: optionalBoolean(asr.align, 'asr.align', true),
      alignerModel: optionalString(asr.alignerModel, 'asr.alignerModel') || 'qwen3-forced-aligner-0.6b',
      maxChunkSeconds: optionalNumber(asr.maxChunkSeconds, 'asr.maxChunkSeconds', 30, 5, 120),
      maxNewTokens: optionalNumber(asr.maxNewTokens, 'asr.maxNewTokens', 1024, 64, 8192),
      vad: {
        thresholdDb: optionalNullableNumber(vad.thresholdDb, 'asr.vad.thresholdDb', null, -90, -5),
        minSilenceMs: optionalNumber(vad.minSilenceMs, 'asr.vad.minSilenceMs', 400, 100, 5000),
        minSpeechMs: optionalNumber(vad.minSpeechMs, 'asr.vad.minSpeechMs', 250, 50, 5000),
        paddingMs: optionalNumber(vad.paddingMs, 'asr.vad.paddingMs', 150, 0, 2000),
        maxGapMs: optionalNumber(vad.maxGapMs, 'asr.vad.maxGapMs', 300, 0, 5000),
        frameMs: optionalNumber(vad.frameMs, 'asr.vad.frameMs', 20, 10, 50),
      },
    },
    llm: {
      mode,
      model: optionalString(llm.model, 'llm.model'),
      baseUrl: optionalString(llm.baseUrl, 'llm.baseUrl') || baseUrlDefault,
      apiKey: optionalString(llm.apiKey, 'llm.apiKey'),
      timeoutMs: optionalNumber(llm.timeoutMs, 'llm.timeoutMs', 300_000, 5_000, 3_600_000),
      maxContextChars: optionalNumber(llm.maxContextChars, 'llm.maxContextChars', 10_000, 1_000, 100_000),
      maxOutputTokens: optionalNumber(llm.maxOutputTokens, 'llm.maxOutputTokens', 4096, 128, 32768),
      temperature: optionalNumber(llm.temperature, 'llm.temperature', 0.1, 0, 2),
      allowNonLoopback: optionalBoolean(llm.allowNonLoopback, 'llm.allowNonLoopback', false),
      harnessProvider: optionalString(llm.harnessProvider, 'llm.harnessProvider'),
      harnessModel: optionalString(llm.harnessModel, 'llm.harnessModel'),
    },
    privacy: {
      strictLocal: optionalBoolean(privacy.strictLocal, 'privacy.strictLocal', true),
      trustedLocalProviders: normalizeStringArray(privacy.trustedLocalProviders, 'privacy.trustedLocalProviders'),
      trustedLocalModels: normalizeStringArray(privacy.trustedLocalModels, 'privacy.trustedLocalModels'),
      untrustedFileToolPolicy: optionalEnum(privacy.untrustedFileToolPolicy, 'privacy.untrustedFileToolPolicy', ['block-data-path', 'block-all', 'off'] as const, 'block-data-path'),
    },
    tasks: {
      autoResume: optionalBoolean(tasks.autoResume, 'tasks.autoResume', false),
      maxTaskHours: optionalNumber(tasks.maxTaskHours, 'tasks.maxTaskHours', 8, 0.1, 72),
      progressPersistIntervalMs: optionalNumber(tasks.progressPersistIntervalMs, 'tasks.progressPersistIntervalMs', 1500, 250, 60_000),
      keepTempFiles: optionalBoolean(tasks.keepTempFiles, 'tasks.keepTempFiles', false),
      cancelGraceMs: optionalNumber(tasks.cancelGraceMs, 'tasks.cancelGraceMs', 15_000, 1_000, 300_000),
    },
    paths: {
      mode: optionalEnum(paths.mode, 'paths.mode', ['explicit', 'roots'] as const, 'explicit'),
      allowedRoots: normalizeStringArray(paths.allowedRoots, 'paths.allowedRoots').map(value => resolve(expandHome(value))),
      allowedExtensions: normalizeExtensions(paths.allowedExtensions),
      maxFileSizeBytes: optionalNumber(paths.maxFileSizeBytes, 'paths.maxFileSizeBytes', 20 * 1024 ** 3, 1024 ** 2, 200 * 1024 ** 3),
      maxDurationMinutes: optionalNumber(paths.maxDurationMinutes, 'paths.maxDurationMinutes', 480, 1, 1440),
    },
    document: {
      defaultMode: optionalEnum(document.defaultMode, 'document.defaultMode', ['concise', 'detailed', 'transcript', 'review'] as const, 'concise'),
      maxCharsPerWindow: optionalNumber(document.maxCharsPerWindow, 'document.maxCharsPerWindow', 10_000, 1000, 100_000),
      maxWindows: optionalNumber(document.maxWindows, 'document.maxWindows', 300, 1, 2000),
      includeFrontMatter: optionalBoolean(document.includeFrontMatter, 'document.includeFrontMatter', true),
    },
    diagnostics: {
      workerLogMaxBytes: optionalNumber(diagnostics.workerLogMaxBytes, 'diagnostics.workerLogMaxBytes', 5 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
      recentLogLines: optionalNumber(diagnostics.recentLogLines, 'diagnostics.recentLogLines', 80, 10, 1000),
    },
  }

  validateCrossFields(normalized)
  return normalized
}

function validateCrossFields(config: VidoraConfig): void {
  if (!config.dataDir) throw new ConfigError('dataDir must not be empty')
  if (!config.worker.workerDir) throw new ConfigError('worker.workerDir must not be empty')
  if (!config.asr.modelsDir) throw new ConfigError('asr.modelsDir must not be empty')
  if (config.privacy.strictLocal && config.llm.mode === 'harness') {
    if (!config.llm.harnessProvider) {
      throw new ConfigError('llm.harnessProvider is required when llm.mode is "harness"')
    }
    if (!config.llm.harnessModel) {
      throw new ConfigError('llm.harnessModel is required when llm.mode is "harness"')
    }
    if (!config.privacy.trustedLocalProviders.includes(config.llm.harnessProvider)) {
      throw new ConfigError(
        `privacy.trustedLocalProviders must contain "${config.llm.harnessProvider}" before Harness LLM reuse is allowed`,
      )
    }
    if (
      config.privacy.trustedLocalModels.length > 0
      && !config.privacy.trustedLocalModels.includes(config.llm.harnessModel)
    ) {
      throw new ConfigError(
        `privacy.trustedLocalModels must contain "${config.llm.harnessModel}" before Harness LLM reuse is allowed`,
      )
    }
  }
  if (config.paths.mode === 'roots' && config.paths.allowedRoots.length === 0) {
    throw new ConfigError('paths.allowedRoots must not be empty when paths.mode is "roots"')
  }
}

export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'vidora',
    validate(value: unknown) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return {
          issues: [{
            message: error instanceof Error ? error.message : String(error),
            path: [],
          }],
        }
      }
    },
  },
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, path: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ConfigError(`${path} must be a string`)
  return value.trim()
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`${path} must be a boolean`)
  return value
}

function optionalNumber(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a finite number`)
  }
  if (value < min || value > max) {
    throw new ConfigError(`${path} must be between ${min} and ${max}`)
  }
  return value
}

function optionalNullableNumber(
  value: unknown,
  path: string,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return fallback
  return optionalNumber(value, path, fallback as number, min, max)
}

function optionalEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`${path} must be one of ${allowed.map(item => `"${item}"`).join(', ')}`)
  }
  return value as T
}

function normalizeStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new ConfigError(`${path} must be an array of strings`)
    const trimmed = item.trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  return result
}

function normalizeExtensions(value: unknown): string[] {
  const raw = normalizeStringArray(value, 'paths.allowedExtensions')
  const result = raw.length > 0 ? raw : DEFAULT_EXTENSIONS
  return result.map(item => {
    const lower = item.toLowerCase()
    return lower.startsWith('.') ? lower : `.${lower}`
  })
}
