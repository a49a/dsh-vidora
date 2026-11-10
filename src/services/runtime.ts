import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VidoraConfig } from '../config.js'
import { DataStore } from '../storage/data-store.js'
import { WorkerManager } from './worker-manager.js'
import { TaskManager } from './task-manager.js'
import { PrivacyPolicy, type AgentLike, type ModelSelectionLike } from './privacy.js'
import {
  checkLocalLlm,
  createLocalLlmClient,
  type HarnessLlmLike,
  type LocalLlmClient,
} from './local-llm.js'
import { DocumentService } from './document-service.js'
import { ALIGNER_MODELS, ASR_MODELS, type ModelCatalogEntry } from '../models.js'
import { pathExists } from '../core/fs.js'
import type { LlmLike } from '../tools/types.js'

const execFileAsync = promisify(execFile)

export interface ModelAvailability {
  id: string
  role: 'asr' | 'aligner'
  label: string
  repo: string
  directory: string
  path: string
  installed: boolean
  bytes: number
  expectedBytes: number
  license: string
  description: string
}

export class VidoraRuntime {
  readonly config: VidoraConfig
  readonly store: DataStore
  readonly worker: WorkerManager
  readonly tasks: TaskManager
  readonly privacy: PrivacyPolicy
  private harness: LlmLike | null = null
  private initPromise: Promise<void> | null = null
  private disposed = false

  constructor(config: VidoraConfig) {
    this.config = config
    this.store = new DataStore(config)
    this.worker = new WorkerManager({
      config: config.worker,
      dataDir: config.dataDir,
      modelsDir: config.asr.modelsDir,
      logPath: join(config.dataDir, 'logs', 'worker.log'),
      logMaxBytes: config.diagnostics.workerLogMaxBytes,
      recentLogLines: config.diagnostics.recentLogLines,
      device: config.asr.device,
      dtype: config.asr.dtype,
      modelPaths: buildModelPaths(config),
      idleUnloadSeconds: config.worker.idleUnloadSeconds,
      maxDurationMinutes: config.paths.maxDurationMinutes,
      maxFileSizeBytes: config.paths.maxFileSizeBytes,
    })
    this.tasks = new TaskManager(config, this.store, this.worker)
    this.privacy = new PrivacyPolicy(config.privacy, config.dataDir)
  }

  ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.store.init()
        await this.tasks.init()
        try {
          const projects = await this.store.recentProjects(200)
          for (const project of projects) this.privacy.addSensitivePath(project.source.path)
        } catch {
          // Sensitive-path indexing is defense in depth; task creation still adds paths.
        }
      })()
    }
    return this.initPromise
  }

  setHarness(llm: LlmLike | null): void {
    this.harness = llm
  }

  getHarness(): LlmLike | null {
    return this.harness
  }

  llmClient(): LocalLlmClient | null {
    return createLocalLlmClient(
      this.config.llm,
      this.config.privacy,
      (this.harness as HarnessLlmLike | null) ?? undefined,
    )
  }

  documents(): DocumentService {
    return new DocumentService(this.config, this.store, this.llmClient())
  }

  async llmHealth() {
    return await checkLocalLlm(
      this.config.llm,
      this.config.privacy,
      (this.harness as HarnessLlmLike | null) ?? undefined,
    )
  }

  async modelAvailability(): Promise<ModelAvailability[]> {
    const results: ModelAvailability[] = []
    for (const entry of Object.values(ASR_MODELS)) {
      results.push(await this.describeModel(entry, 'asr'))
    }
    for (const entry of Object.values(ALIGNER_MODELS)) {
      results.push(await this.describeModel(entry, 'aligner'))
    }
    return results
  }

  private async describeModel(entry: ModelCatalogEntry, role: 'asr' | 'aligner'): Promise<ModelAvailability> {
    const path = join(this.config.asr.modelsDir, entry.directory)
    const installed = await modelDirectoryLooksInstalled(path)
    const bytes = installed ? await safeDirectorySize(path) : 0
    return {
      id: entry.id,
      role,
      label: entry.label,
      repo: entry.repo,
      directory: entry.directory,
      path,
      installed,
      bytes,
      expectedBytes: entry.approxBytes,
      license: entry.license,
      description: entry.description,
    }
  }

  async ffmpegVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 })
      return stdout.split('\n')[0]?.trim() ?? null
    } catch {
      return null
    }
  }

  async pythonVersion(): Promise<string | null> {
    const python = this.config.worker.pythonPath || defaultVenvPython(this.config.worker.workerDir)
    try {
      const { stdout } = await execFileAsync(python, ['--version'], { timeout: 5000 })
      return stdout.trim() || null
    } catch {
      try {
        const { stdout } = await execFileAsync('python3', ['--version'], { timeout: 5000 })
        return stdout.trim() || null
      } catch {
        return null
      }
    }
  }

  privacyFor(agent: AgentLike | undefined): {
    selection: Readonly<ModelSelectionLike> | undefined
    trusted: boolean
    description: ReturnType<PrivacyPolicy['describe']>
  } {
    const selection = this.privacy.currentSelection(agent)
    return {
      selection,
      trusted: this.privacy.isTrusted(selection),
      description: this.privacy.describe(selection),
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.tasks.dispose()
  }
}

function buildModelPaths(config: VidoraConfig): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const entry of [...Object.values(ASR_MODELS), ...Object.values(ALIGNER_MODELS)]) {
    paths[entry.id] = join(config.asr.modelsDir, entry.directory)
  }
  return paths
}

async function modelDirectoryLooksInstalled(path: string): Promise<boolean> {
  if (!(await pathExists(join(path, 'config.json')))) return false
  return (
    (await pathExists(join(path, 'model.safetensors')))
    || (await pathExists(join(path, 'model.safetensors.index.json')))
  )
}

async function safeDirectorySize(path: string): Promise<number> {
  try {
    let total = 0
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isFile()) {
        total += (await stat(full)).size
      } else if (entry.isDirectory()) {
        total += await safeDirectorySize(full)
      }
    }
    return total
  } catch {
    return 0
  }
}

function defaultVenvPython(workerDir: string): string {
  return process.platform === 'win32'
    ? join(workerDir, '.venv', 'Scripts', 'python.exe')
    : join(workerDir, '.venv', 'bin', 'python')
}
