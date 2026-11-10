import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, mkdir, rename, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { WorkerConfig } from '../config.js'
import type {
  WorkerEvent,
  WorkerInitResult,
  WorkerRequest,
  WorkerResponse,
  WorkerStatusResult,
} from './worker-protocol.js'

const execFileAsync = promisify(execFile)

export class WorkerError extends Error {
  readonly code: string
  readonly details: unknown
  readonly stage: string | undefined

  constructor(message: string, code: string, details?: unknown, stage?: string) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.details = details
    this.stage = stage
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  method: string
}

export type WorkerEventListener = (event: WorkerEvent) => void

export interface WorkerManagerOptions {
  config: WorkerConfig
  dataDir: string
  modelsDir: string
  logPath: string
  logMaxBytes: number
  recentLogLines: number
  device: string
  dtype: string
  modelPaths: Record<string, string>
  idleUnloadSeconds: number
  maxDurationMinutes: number
  maxFileSizeBytes: number
  onLog?: (line: string) => void
}

export class WorkerManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private starting: Promise<WorkerInitResult> | null = null
  private initResult: WorkerInitResult | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Set<WorkerEventListener>()
  private stderrLines: string[] = []
  private logStream: WriteStream | null = null
  private stopping = false
  private spawnCount = 0
  private lastExit: { code: number | null; signal: NodeJS.Signals | null; at: string } | null = null
  private readonly logPath: string

  constructor(private readonly options: WorkerManagerOptions) {
    this.logPath = options.logPath
  }

  isRunning(): boolean {
    return Boolean(this.child && this.initialized && !this.stopping)
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  getLastExit(): { code: number | null; signal: NodeJS.Signals | null; at: string } | null {
    return this.lastExit
  }

  getInitResult(): WorkerInitResult | null {
    return this.initResult
  }

  onEvent(listener: WorkerEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recentLogs(count = 20): string[] {
    return this.stderrLines.slice(-count)
  }

  async ensureStarted(): Promise<WorkerInitResult> {
    if (this.stopping) {
      throw new WorkerError('Worker 正在关闭', 'WORKER_STOPPING')
    }
    if (this.child && this.initialized && this.initResult) return this.initResult
    if (this.starting) return await this.starting
    this.starting = this.start()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async start(): Promise<WorkerInitResult> {
    if (!this.options.config.autoStart) {
      throw new WorkerError('worker.autoStart=false 且 Worker 未运行', 'WORKER_NOT_RUNNING')
    }
    const python = await this.resolvePython()
    const main = join(this.options.config.workerDir, 'main.py')
    try {
      await access(main)
    } catch {
      throw new WorkerError(
        `未找到 Python Worker：${main}。请确认插件包完整，或设置 worker.workerDir。`,
        'WORKER_MISSING',
      )
    }
    await mkdir(this.options.dataDir, { recursive: true })
    await this.rotateLogIfNeeded()
    this.logStream = createWriteStream(this.logPath, { flags: 'a', mode: 0o600 })
    this.log(`[worker] spawning python=${python} main=${main}`)
    const child = spawn(python, [main, '--data-dir', this.options.dataDir], {
      cwd: this.options.config.workerDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HOME: join(this.options.dataDir, 'cache', 'huggingface'),
        XDG_CACHE_HOME: join(this.options.dataDir, 'cache'),
        VIDORA_DATA_DIR: this.options.dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.spawnCount += 1
    this.initialized = false
    this.initResult = null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', line => this.handleStdoutLine(line))
    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', line => this.handleStderrLine(line))

    const exited = new Promise<never>((_, reject) => {
      child.once('error', error => {
        this.log(`[worker] spawn error: ${error.message}`)
        this.handleExit(null, null, error)
        reject(new WorkerError(
          `无法启动 Python Worker（${python}）：${error.message}`,
          'WORKER_SPAWN_FAILED',
        ))
      })
      child.once('exit', (code, signal) => {
        this.handleExit(code, signal)
        reject(new WorkerError(
          `Python Worker 在初始化前退出（code=${String(code)}, signal=${String(signal)}）`,
          'WORKER_EXITED',
          { recentLogs: this.recentLogs(10) },
        ))
      })
    })

    try {
      const result = await Promise.race([
        this.sendRequest<WorkerInitResult>('worker.initialize', {
          data_dir: this.options.dataDir,
          models_dir: this.options.modelsDir,
          device: this.options.device,
          dtype: this.options.dtype,
          log_level: this.options.config.logLevel,
          model_paths: this.options.modelPaths,
          offline: true,
          idle_unload_seconds: this.options.idleUnloadSeconds,
          max_duration_minutes: this.options.maxDurationMinutes,
          max_file_size_bytes: this.options.maxFileSizeBytes,
        }, this.options.config.startTimeoutMs + 90_000, true).then(value => {
          this.initialized = true
          this.initResult = value
          return value
        }),
        exited,
      ])
      this.log(`[worker] initialized version=${result.worker_version} device=${result.device.selected}`)
      return result
    } catch (error) {
      await this.killChild()
      throw error
    }
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.config.requestTimeoutMs,
  ): Promise<T> {
    await this.ensureStarted()
    return await this.sendRequest<T>(method, params, timeoutMs, false)
  }

  private sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    duringStart: boolean,
  ): Promise<T> {
    const child = this.child
    if (!child || !child.stdin.writable) {
      return Promise.reject(new WorkerError('Worker 未运行', 'WORKER_NOT_RUNNING'))
    }
    const requestId = `req-${randomUUID()}`
    const message: WorkerRequest = {
      protocol_version: 1,
      request_id: requestId,
      method,
      params,
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new WorkerError(
          `Worker 请求超时：${method}（${timeoutMs}ms）`,
          'WORKER_TIMEOUT',
          { recentLogs: this.recentLogs(10) },
        ))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        method,
      })
      const line = `${JSON.stringify(message)}\n`
      try {
        const accepted = child.stdin.write(line)
        if (!accepted) {
          child.stdin.once('drain', () => {})
        }
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new WorkerError(
          `写入 Worker 失败：${error instanceof Error ? error.message : String(error)}`,
          'WORKER_WRITE_FAILED',
        ))
      }
      if (duringStart) {
        // The initialization timeout already covers model discovery; nothing else.
      }
    })
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: WorkerResponse | WorkerEvent
    try {
      message = JSON.parse(trimmed) as WorkerResponse | WorkerEvent
    } catch {
      this.log(`[worker] non-JSON stdout: ${trimmed.slice(0, 300)}`)
      return
    }
    if (message.protocol_version !== 1) {
      this.log(`[worker] protocol mismatch: ${String((message as { protocol_version?: unknown }).protocol_version)}`)
    }
    if ('event' in message && typeof message.event === 'string') {
      const event = message as WorkerEvent
      if (event.event === 'worker.log') {
        this.log(`[worker] ${String(event.message ?? '')}`)
        return
      }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch (error) {
          this.log(`[worker] event listener failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }
    const response = message as WorkerResponse
    const pending = this.pending.get(response.request_id)
    if (!pending) {
      this.log(`[worker] response for unknown request ${response.request_id}`)
      return
    }
    this.pending.delete(response.request_id)
    clearTimeout(pending.timer)
    if (response.error) {
      pending.reject(new WorkerError(
        response.error.message,
        response.error.code,
        response.error.details,
        response.error.stage,
      ))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trimEnd()
    if (!trimmed) return
    this.stderrLines.push(trimmed)
    if (this.stderrLines.length > this.options.recentLogLines) {
      this.stderrLines.splice(0, this.stderrLines.length - this.options.recentLogLines)
    }
    this.log(`[stderr] ${trimmed}`)
    this.options.onLog?.(trimmed)
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: Error,
  ): void {
    const wasRunning = this.child !== null
    const exitedPid = this.child?.pid ?? null
    this.lastExit = { code, signal, at: new Date().toISOString() }
    this.child = null
    this.initialized = false
    this.initResult = null
    const error = new WorkerError(
      spawnError
        ? `Python Worker 启动失败：${spawnError.message}`
        : `Python Worker 已退出（code=${String(code)}, signal=${String(signal)}）`,
      spawnError ? 'WORKER_SPAWN_FAILED' : 'WORKER_EXITED',
      { recentLogs: this.recentLogs(20) },
    )
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(error)
    }
    this.logStream?.end()
    this.logStream = null
    if (wasRunning) {
      for (const listener of this.listeners) {
        try {
          listener({
            protocol_version: 1,
            request_id: 'worker-exit',
            event: 'worker.exit',
            error: {
              code: error.code,
              message: error.message,
              details: { code, signal, pid: exitedPid, recentLogs: this.recentLogs(20) },
            },
          })
        } catch {
          // exit notification must never throw
        }
      }
    }
    if (spawnError) this.log(`[worker] spawn failed: ${spawnError.message}`)
    else this.log(`[worker] exited code=${String(code)} signal=${String(signal)}`)
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return await this.request('asr.cancel', { task_id: taskId }, 15_000)
  }

  async unloadModel(): Promise<unknown> {
    return await this.request('worker.unload_model', {}, 30_000)
  }

  async getStatus(): Promise<WorkerStatusResult> {
    return await this.request<WorkerStatusResult>('worker.get_status', {}, 15_000)
  }

  async shutdown(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    try {
      if (this.initialized) {
        await this.sendRequest('worker.shutdown', {
          wait_for_running_ms: 5000,
          cancel_running: false,
        }, this.options.config.shutdownTimeoutMs, false).catch(() => undefined)
      }
      await this.waitForExit(this.options.config.shutdownTimeoutMs)
    } finally {
      await this.killChild()
      this.stopping = false
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child
    if (!child) return
    await Promise.race([
      new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
      new Promise<void>(resolvePromise => setTimeout(resolvePromise, timeoutMs).unref?.()),
    ])
  }

  private async killChild(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    const exited = await Promise.race([
      new Promise<boolean>(resolvePromise => child.once('exit', () => resolvePromise(true))),
      new Promise<boolean>(resolvePromise => setTimeout(() => resolvePromise(false), 3000).unref?.()),
    ])
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    this.child = null
    this.initialized = false
    this.initResult = null
    this.logStream?.end()
    this.logStream = null
  }

  private async resolvePython(): Promise<string> {
    const configured = this.options.config.pythonPath
    if (configured) {
      try {
        if (isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
          await access(configured)
        } else {
          await execFileAsync(configured, ['--version'], { timeout: 5000 })
        }
      } catch {
        throw new WorkerError(
          `配置的 Python 不存在或不可执行：${configured}`,
          'WORKER_PYTHON_NOT_FOUND',
        )
      }
      return configured
    }
    const venvPython = process.platform === 'win32'
      ? join(this.options.config.workerDir, '.venv', 'Scripts', 'python.exe')
      : join(this.options.config.workerDir, '.venv', 'bin', 'python')
    try {
      await access(venvPython)
      return venvPython
    } catch {
      // Fall back to PATH; the worker will report missing Python packages.
      return process.platform === 'win32' ? 'python' : 'python3'
    }
  }

  private async rotateLogIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.logPath)
      if (info.size > this.options.logMaxBytes) {
        await rename(this.logPath, `${this.logPath}.1`).catch(() => {})
      }
    } catch {
      // no existing log
    }
    await mkdir(dirname(this.logPath), { recursive: true }).catch(() => {})
  }

  private log(line: string): void {
    const text = `[${new Date().toISOString()}] ${line}\n`
    try {
      this.logStream?.write(text)
    } catch {
      // diagnostics must not break the tool path
    }
  }
}
