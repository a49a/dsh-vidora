import { randomUUID } from 'node:crypto'
import type { VidoraConfig } from '../config.js'
import type {
  CacheEntry,
  TaskStage,
  Transcript,
  VidoraTask,
} from '../core/types.js'
import { TASK_SCHEMA_VERSION } from '../core/types.js'
import { sha256File } from '../core/fs.js'
import { shortHash, stableStringify, sha256Hex } from '../core/hash.js'
import { nowIso } from '../core/time.js'
import { parseTranscript } from '../core/transcript.js'
import { DataStore } from '../storage/data-store.js'
import type { WorkerEvent, TranscribeParams } from './worker-protocol.js'
import { WorkerManager, WorkerError } from './worker-manager.js'
import { modelEntry, ASR_MODELS, ALIGNER_MODELS } from '../models.js'
import { pathExists } from '../core/fs.js'

const PIPELINE_VERSION = 1

export interface MediaInput {
  path: string
  size: number
  extension: string
}

export interface CreateTranscribeInput {
  media: MediaInput
  model?: string
  language?: string
  align?: boolean
  force?: boolean
  context?: string
  resumeTaskId?: string
  signal?: AbortSignal
}

export interface CreateTranscribeResult {
  task: VidoraTask
  transcript: Transcript | null
  cached: boolean
  deduplicated: boolean
  warnings: string[]
}

export class TaskManager {
  private readonly tasks = new Map<string, VidoraTask>()
  private readonly activeByDedupe = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly timeoutReasons = new Map<string, string>()
  private readonly lastPersist = new Map<string, number>()
  private readonly taskWorkerPid = new Map<string, number>()
  private unsubscribe: (() => void) | null = null
  private disposed = false
  private eventChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: VidoraConfig,
    private readonly store: DataStore,
    private readonly worker: WorkerManager,
  ) {}

  async init(): Promise<void> {
    this.unsubscribe = this.worker.onEvent(event => {
      this.eventChain = this.eventChain
        .then(() => this.handleWorkerEvent(event))
        .catch(() => undefined)
    })
    const tasks = await this.store.listTasks()
    for (const task of tasks) {
      this.tasks.set(task.id, task)
      if (task.status === 'running' || task.status === 'queued' || task.status === 'cancelling') {
        const interrupted: VidoraTask = {
          ...task,
          status: 'interrupted',
          stage: task.stage === 'completed' ? 'completed' : task.stage,
          updated_at: nowIso(),
          finished_at: task.finished_at ?? nowIso(),
          error: {
            code: 'WORKER_INTERRUPTED',
            message: 'Vidora 上次退出时任务尚未完成；检查点已保留，可恢复。',
            stage: task.stage,
          },
          resumable: true,
        }
        this.tasks.set(task.id, interrupted)
        await this.store.saveTask(interrupted)
      }
      if (task.status === 'interrupted' || task.status === 'cancelled' || task.status === 'failed') {
        // Completed checkpoints are resumable; keep the index for status listing.
      }
      if (task.status === 'running' || task.status === 'queued') {
        this.activeByDedupe.set(task.dedupe_key, task.id)
      }
    }
    if (this.config.tasks.autoResume) {
      for (const task of this.tasks.values()) {
        if (task.status === 'interrupted' && task.resumable) {
          void this.resumeTask(task.id).catch(() => undefined)
        }
      }
    }
  }

  async create(input: CreateTranscribeInput): Promise<CreateTranscribeResult> {
    if (this.disposed) throw new VidoraTaskError('TaskManager 已释放', 'TASK_MANAGER_DISPOSED')
    if (input.resumeTaskId) {
      const task = await this.resumeTask(input.resumeTaskId)
      return { task, transcript: null, cached: false, deduplicated: true, warnings: task.warnings }
    }
    const model = input.model || this.config.asr.defaultModel
    if (!(model in ASR_MODELS)) {
      throw new VidoraTaskError(
        `不支持的 ASR 模型：${model}。可用：${Object.keys(ASR_MODELS).join(', ')}`,
        'UNSUPPORTED_MODEL',
      )
    }
    const modelInfo = modelEntry(model)!
    const modelPath = `${this.config.asr.modelsDir}/${modelInfo.directory}`
    if (!(await pathExists(modelPath))) {
      throw new VidoraTaskError(
        `本地 ASR 模型未安装：${modelPath}。来源 ${modelInfo.repo}，约 ${formatBytes(modelInfo.approxBytes)}。`
        + ` 运行 npm run prepare:models -- --model ${model} --yes 下载。`,
        'MODEL_NOT_FOUND',
      )
    }
    const requestedAlign = input.align ?? this.config.asr.align
    const alignerId = requestedAlign ? this.config.asr.alignerModel : null
    const alignerInfo = alignerId ? ALIGNER_MODELS[alignerId] : undefined
    const alignerPath = alignerInfo ? `${this.config.asr.modelsDir}/${alignerInfo.directory}` : null
    const alignerInstalled = alignerPath ? await pathExists(alignerPath) : false
    const align = requestedAlign && alignerInstalled
    const warnings: string[] = []
    if (requestedAlign && !alignerInstalled) {
      warnings.push(
        `对齐模型未安装（${alignerId}，来源 ${alignerInfo?.repo ?? 'unknown'}，约 ${formatBytes(alignerInfo?.approxBytes ?? 0)}），`
        + '本次将使用分段级时间戳（timing_status="chunk"）。运行 npm run prepare:models 可安装对齐模型。',
      )
    }

    if (input.signal?.aborted) throw abortError()
    const sourceHash = await sha256File(input.media.path)
    if (input.signal?.aborted) throw abortError()
    const projectId = `prj-${sourceHash.slice(0, 16)}`
    const language = input.language || this.config.asr.language || 'auto'
    const context = (input.context || '').trim().slice(0, 2000)
    const params = {
      language,
      align,
      context,
      max_chunk_seconds: this.config.asr.maxChunkSeconds,
      vad: {
        threshold_db: this.config.asr.vad.thresholdDb,
        min_silence_ms: this.config.asr.vad.minSilenceMs,
        min_speech_ms: this.config.asr.vad.minSpeechMs,
        padding_ms: this.config.asr.vad.paddingMs,
        max_gap_ms: this.config.asr.vad.maxGapMs,
        frame_ms: this.config.asr.vad.frameMs,
      },
      pipeline_version: PIPELINE_VERSION,
    }
    const paramsHash = sha256Hex(stableStringify({
      ...params,
      model,
      aligner: align ? alignerId : null,
    }))
    const dedupeKey = sha256Hex(stableStringify({
      source_sha256: sourceHash,
      model,
      params_hash: paramsHash,
      pipeline_version: PIPELINE_VERSION,
    }))

    const activeId = this.activeByDedupe.get(dedupeKey)
    if (activeId) {
      const active = await this.getTask(activeId)
      if (active) {
        return {
          task: active,
          transcript: null,
          cached: false,
          deduplicated: true,
          warnings: active.warnings,
        }
      }
    }

    if (!input.force) {
      const cache = await this.store.lookupCache(dedupeKey)
      if (cache && await pathExists(cache.transcript_path)) {
        try {
          const transcript = parseTranscript(JSON.parse(await readText(cache.transcript_path)))
          if (transcript.source.sha256 === sourceHash) {
            return {
              task: makeCachedTask(cache, transcript),
              transcript,
              cached: true,
              deduplicated: false,
              warnings: [...warnings, '命中本地缓存：相同媒体内容、模型和处理参数，未重新执行 ASR。'],
            }
          }
        } catch {
          await this.store.removeCache(dedupeKey).catch(() => {})
        }
      }
    }

    const taskId = `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const transcriptId = `tr-${shortHash(`${sourceHash}:${paramsHash}:${Date.now()}`, 20)}`
    const transcriptPath = this.store.transcriptPath(projectId, transcriptId)
    await this.store.initProject(projectId)
    await this.store.initTask(taskId)
    const now = nowIso()
    const task: VidoraTask = {
      version: TASK_SCHEMA_VERSION,
      id: taskId,
      status: 'queued',
      stage: 'preparing',
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      progress: {
        stage: 'preparing',
        processed_ms: 0,
        total_ms: 0,
        completed_chunks: 0,
        total_chunks: 0,
      },
      source: {
        path: input.media.path,
        sha256: sourceHash,
        size_bytes: input.media.size,
        duration_ms: null,
      },
      project_id: projectId,
      transcript_id: transcriptId,
      params,
      model,
      aligner: align ? alignerId : null,
      dedupe_key: dedupeKey,
      task_dir: this.store.taskDir(taskId),
      transcript_path: transcriptPath,
      worker_request_id: null,
      error: null,
      result: null,
      warnings,
      resumable: false,
    }
    this.tasks.set(taskId, task)
    await this.store.saveSource({
      project_id: projectId,
      path: input.media.path,
      sha256: sourceHash,
      size_bytes: input.media.size,
      duration_ms: null,
      container: null,
      audio_codec: null,
      sample_rate: null,
      channels: null,
      created_at: now,
      updated_at: now,
      transcript_ids: [],
      document_ids: [],
    })
    await this.store.saveTask(task)
    this.activeByDedupe.set(dedupeKey, taskId)
    await this.startWorkerTask(task, modelPath, alignerPath, align, false)
    return { task: (await this.getTask(taskId)) ?? task, transcript: null, cached: false, deduplicated: false, warnings }
  }

  async resumeTask(taskId: string): Promise<VidoraTask> {
    const task = await this.getTask(taskId)
    if (!task) throw new VidoraTaskError(`任务不存在：${taskId}`, 'TASK_NOT_FOUND')
    if (task.status === 'completed' || task.status === 'running' || task.status === 'queued') return task
    if (!task.resumable && task.status !== 'interrupted' && task.status !== 'cancelled') {
      throw new VidoraTaskError(`任务不可恢复：${task.status}`, 'TASK_NOT_RESUMABLE')
    }
    if (!(await pathExists(task.source.path))) {
      throw new VidoraTaskError(`源文件不存在，无法恢复：${task.source.path}`, 'INPUT_NOT_FOUND')
    }
    const modelInfo = ASR_MODELS[task.model]
    if (!modelInfo) throw new VidoraTaskError(`任务模型不受支持：${task.model}`, 'UNSUPPORTED_MODEL')
    const modelPath = `${this.config.asr.modelsDir}/${modelInfo.directory}`
    const alignerInfo = task.aligner ? ALIGNER_MODELS[task.aligner] : undefined
    const alignerPath = alignerInfo ? `${this.config.asr.modelsDir}/${alignerInfo.directory}` : null
    task.status = 'queued'
    task.stage = 'preparing'
    task.error = null
    task.finished_at = null
    task.updated_at = nowIso()
    task.resumable = false
    this.tasks.set(task.id, task)
    await this.store.saveTask(task)
    this.activeByDedupe.set(task.dedupe_key, task.id)
    await this.startWorkerTask(task, modelPath, alignerPath, Boolean(task.aligner), true)
    return (await this.getTask(task.id)) ?? task
  }

  private async startWorkerTask(
    task: VidoraTask,
    modelPath: string,
    alignerPath: string | null,
    align: boolean,
    resume: boolean,
  ): Promise<void> {
    try {
      const params: TranscribeParams = {
        task_id: task.id,
        file_path: task.source.path,
        source_sha256: task.source.sha256,
        project_id: task.project_id,
        transcript_id: task.transcript_id,
        transcript_path: task.transcript_path,
        task_dir: task.task_dir,
        model: task.model,
        model_path: modelPath,
        aligner_model: align ? task.aligner : null,
        aligner_model_path: align ? alignerPath : null,
        language: task.params.language,
        align,
        context: task.params.context,
        device: this.config.asr.device,
        dtype: this.config.asr.dtype,
        max_chunk_seconds: task.params.max_chunk_seconds,
        max_new_tokens: this.config.asr.maxNewTokens,
        vad: task.params.vad,
        resume,
        keep_temp_files: this.config.tasks.keepTempFiles,
      }
      const accepted = await this.worker.request<{ task_id: string; status: string }>(
        'asr.transcribe',
        params as unknown as Record<string, unknown>,
        60_000,
      )
      const workerPid = this.worker.getPid()
      if (workerPid !== null) this.taskWorkerPid.set(task.id, workerPid)
      task.worker_request_id = accepted.task_id
      task.status = accepted.status === 'queued' ? 'queued' : 'running'
      task.stage = 'preparing'
      task.started_at = task.started_at ?? nowIso()
      task.updated_at = nowIso()
      await this.store.saveTask(task)
      this.armTimeout(task)
    } catch (error) {
      const workerError = error instanceof WorkerError ? error : null
      task.status = 'failed'
      task.stage = 'failed'
      task.finished_at = nowIso()
      task.updated_at = nowIso()
      task.error = {
        code: workerError?.code ?? 'WORKER_START_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stage: 'preparing',
      }
      task.resumable = true
      this.activeByDedupe.delete(task.dedupe_key)
      await this.store.saveTask(task)
      throw error
    }
  }

  async getTask(taskId: string): Promise<VidoraTask | undefined> {
    const inMemory = this.tasks.get(taskId)
    if (inMemory) return inMemory
    const stored = await this.store.loadTask(taskId)
    if (stored) this.tasks.set(stored.id, stored)
    return stored
  }

  async getStatus(taskId?: string): Promise<VidoraTask | undefined> {
    if (taskId) return await this.getTask(taskId)
    const active = [...this.tasks.values()]
      .filter(task => task.status === 'running' || task.status === 'queued' || task.status === 'cancelling')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    if (active) return active
    const all = await this.store.listTasks()
    return all.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  }

  async cancel(taskId: string): Promise<VidoraTask> {
    const task = await this.getTask(taskId)
    if (!task) throw new VidoraTaskError(`任务不存在：${taskId}`, 'TASK_NOT_FOUND')
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    if (!this.worker.isRunning()) {
      task.status = 'interrupted'
      task.updated_at = nowIso()
      task.finished_at = nowIso()
      task.error = {
        code: 'WORKER_NOT_RUNNING',
        message: 'Worker 未运行；任务标记为中断，检查点保留。',
        stage: task.stage,
      }
      task.resumable = true
      this.activeByDedupe.delete(task.dedupe_key)
      await this.store.saveTask(task)
      return task
    }
    task.status = 'cancelling'
    task.updated_at = nowIso()
    await this.store.saveTask(task)
    try {
      await this.worker.cancelTask(task.id)
    } catch (error) {
      task.status = 'interrupted'
      task.updated_at = nowIso()
      task.error = {
        code: error instanceof WorkerError ? error.code : 'CANCEL_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stage: task.stage,
      }
      task.resumable = true
      this.activeByDedupe.delete(task.dedupe_key)
      await this.store.saveTask(task)
      return task
    }
    const deadline = Date.now() + this.config.tasks.cancelGraceMs
    while (Date.now() < deadline) {
      const current = await this.getTask(task.id)
      if (!current || current.status !== 'cancelling') return current ?? task
      await sleep(250)
    }
    const current = await this.getTask(task.id)
    return current ?? task
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'queued' || task.status === 'cancelling') {
        task.status = 'interrupted'
        task.updated_at = nowIso()
        task.finished_at = nowIso()
        task.error = {
          code: 'WORKER_SHUTDOWN',
          message: '插件卸载或进程退出；任务已中断，检查点保留，可恢复。',
          stage: task.stage,
        }
        task.resumable = true
        await this.store.saveTask(task).catch(() => {})
      }
    }
    await this.worker.shutdown().catch(() => {})
    await this.store.cacheSize().catch(() => 0)
  }

  private async handleWorkerEvent(event: WorkerEvent): Promise<void> {
    if (event.event === 'worker.exit') {
      const exitDetails = event.error?.details as { pid?: unknown } | undefined
      const exitedPid = typeof exitDetails?.pid === 'number' ? exitDetails.pid : null
      for (const task of this.tasks.values()) {
        const taskPid = this.taskWorkerPid.get(task.id)
        if (exitedPid !== null && taskPid !== undefined && taskPid !== exitedPid) continue
        if (task.status === 'running' || task.status === 'queued' || task.status === 'cancelling') {
          task.status = 'interrupted'
          task.updated_at = nowIso()
          task.finished_at = nowIso()
          task.error = {
            code: 'WORKER_EXITED',
            message: event.error?.message || 'Python Worker 异常退出；检查点保留。',
            stage: task.stage,
          }
          task.resumable = true
          this.activeByDedupe.delete(task.dedupe_key)
          this.taskWorkerPid.delete(task.id)
          await this.store.saveTask(task).catch(() => {})
        }
      }
      return
    }
    const taskId = event.task_id
    if (!taskId) return
    const task = await this.getTask(taskId)
    if (!task) return
    if (event.event === 'task.progress' && event.progress) {
      task.status = 'running'
      task.stage = event.progress.stage
      task.progress = { ...event.progress }
      task.updated_at = nowIso()
      this.tasks.set(task.id, task)
      const now = Date.now()
      const last = this.lastPersist.get(task.id) ?? 0
      if (now - last >= this.config.tasks.progressPersistIntervalMs) {
        this.lastPersist.set(task.id, now)
        await this.store.saveTask(task)
      }
      return
    }
    if (event.event === 'task.completed' && event.result) {
      const result = event.result
      task.stage = 'completed'
      task.finished_at = nowIso()
      task.updated_at = nowIso()
      task.progress = {
        stage: 'completed',
        processed_ms: task.progress.total_ms,
        total_ms: task.progress.total_ms,
        completed_chunks: task.progress.total_chunks,
        total_chunks: task.progress.total_chunks,
      }
      task.result = {
        transcript_id: result.transcript_id,
        transcript_path: result.transcript_path,
        duration_ms: result.duration_ms,
        segment_count: result.segment_count,
        language: result.language,
        model: result.model,
        processing_ms: result.processing_ms,
        peak_memory_mb: result.peak_memory_mb ?? null,
      }
      task.error = null
      task.resumable = false
      task.warnings = unique([...task.warnings, ...(result.warnings ?? [])])
      this.clearTimeout(task.id)
      // Index the transcript before publishing `completed`, so a caller that
      // immediately repeats the same request hits the cache instead of racing
      // the index write.
      await this.afterTranscriptCompleted(task)
      task.status = 'completed'
      task.updated_at = nowIso()
      this.activeByDedupe.delete(task.dedupe_key)
      this.taskWorkerPid.delete(task.id)
      await this.store.saveTask(task)
      return
    }
    if (event.event === 'task.failed') {
      const timeoutReason = this.timeoutReasons.get(task.id)
      task.status = 'failed'
      task.stage = 'failed'
      task.finished_at = nowIso()
      task.updated_at = nowIso()
      task.error = {
        code: timeoutReason ? 'TASK_TIMEOUT' : event.error?.code ?? 'TASK_FAILED',
        message: timeoutReason ?? event.error?.message ?? '任务失败',
        stage: (event.error?.stage as TaskStage | undefined) ?? task.stage,
      }
      task.resumable = event.error?.resumable !== false
      this.activeByDedupe.delete(task.dedupe_key)
      this.clearTimeout(task.id)
      this.timeoutReasons.delete(task.id)
      await this.store.saveTask(task)
      return
    }
    if (event.event === 'task.cancelled') {
      const timeoutReason = this.timeoutReasons.get(task.id)
      if (timeoutReason) {
        task.status = 'failed'
        task.stage = 'failed'
        task.error = { code: 'TASK_TIMEOUT', message: timeoutReason, stage: task.stage }
      } else {
        task.status = 'cancelled'
        task.stage = 'cancelled'
        task.error = event.error
          ? { code: event.error.code, message: event.error.message, stage: task.stage }
          : null
      }
      task.finished_at = nowIso()
      task.updated_at = nowIso()
      task.resumable = event.error?.resumable !== false
      this.activeByDedupe.delete(task.dedupe_key)
      this.clearTimeout(task.id)
      this.timeoutReasons.delete(task.id)
      this.taskWorkerPid.delete(task.id)
      await this.store.saveTask(task)
    }
  }

  private async afterTranscriptCompleted(task: VidoraTask): Promise<void> {
    try {
      const transcript = parseTranscript(JSON.parse(await readText(task.transcript_path)))
      await this.store.saveTranscript(transcript)
      const entry: CacheEntry = {
        dedupe_key: task.dedupe_key,
        project_id: transcript.project_id,
        transcript_id: transcript.id,
        source_sha256: transcript.source.sha256,
        model: task.model,
        params_hash: sha256Hex(stableStringify({
          ...transcript.params,
          model: transcript.model,
          aligner: transcript.model_info.aligner ?? null,
        })),
        transcript_path: task.transcript_path,
        created_at: nowIso(),
        segment_count: transcript.segments.length,
        duration_ms: transcript.source.duration_ms,
      }
      await this.store.putCache(entry)
      if (this.config.tasks.keepTempFiles === false) {
        const { rm } = await import('node:fs/promises')
        await rm(`${task.task_dir}/work`, { recursive: true, force: true }).catch(() => {})
      }
    } catch (error) {
      task.warnings = unique([
        ...task.warnings,
        `结果已生成，但缓存索引更新失败：${error instanceof Error ? error.message : String(error)}`,
      ])
      await this.store.saveTask(task)
    }
  }

  private armTimeout(task: VidoraTask): void {
    this.clearTimeout(task.id)
    const ms = this.config.tasks.maxTaskHours * 3_600_000
    const timer = setTimeout(() => {
      this.timeoutReasons.set(task.id, `任务超过最长运行时间 ${this.config.tasks.maxTaskHours} 小时，已请求取消。`)
      void this.worker.cancelTask(task.id).catch(() => undefined)
    }, ms)
    timer.unref?.()
    this.timers.set(task.id, timer)
  }

  private clearTimeout(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) clearTimeout(timer)
    this.timers.delete(taskId)
  }
}

export { VidoraTaskError }

class VidoraTaskError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'VidoraTaskError'
    this.code = code
  }
}

function makeCachedTask(cache: CacheEntry, transcript: Transcript): VidoraTask {
  const now = nowIso()
  return {
    version: TASK_SCHEMA_VERSION,
    id: `cached-${cache.transcript_id}`,
    status: 'completed',
    stage: 'completed',
    created_at: cache.created_at,
    updated_at: now,
    started_at: cache.created_at,
    finished_at: now,
    progress: {
      stage: 'completed',
      processed_ms: transcript.source.duration_ms,
      total_ms: transcript.source.duration_ms,
      completed_chunks: transcript.stats.completed_chunks,
      total_chunks: transcript.stats.total_chunks,
    },
    source: {
      path: transcript.source.path,
      sha256: transcript.source.sha256,
      size_bytes: transcript.source.size_bytes,
      duration_ms: transcript.source.duration_ms,
    },
    project_id: transcript.project_id,
    transcript_id: transcript.id,
    params: transcript.params,
    model: transcript.model,
    aligner: transcript.model_info.aligner ?? null,
    dedupe_key: cache.dedupe_key,
    task_dir: '',
    transcript_path: cache.transcript_path,
    worker_request_id: null,
    error: null,
    result: {
      transcript_id: transcript.id,
      transcript_path: cache.transcript_path,
      duration_ms: transcript.source.duration_ms,
      segment_count: transcript.segments.length,
      language: transcript.language,
      model: transcript.model,
      processing_ms: transcript.stats.processing_ms,
      peak_memory_mb: transcript.stats.peak_memory_mb,
    },
    warnings: ['命中本地缓存，未重新执行 ASR。'],
    resumable: false,
  }
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path, 'utf8')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${bytes} B`
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

export { PIPELINE_VERSION }
export { VidoraTaskError as TaskFailure }
