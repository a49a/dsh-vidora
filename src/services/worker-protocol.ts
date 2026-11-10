import type { TaskProgress, TaskResult } from '../core/types.js'

export interface WorkerRequest {
  protocol_version: 1
  request_id: string
  method: string
  params: Record<string, unknown>
}

export interface WorkerResponse {
  protocol_version: 1
  request_id: string
  result?: unknown
  error?: {
    code: string
    message: string
    stage?: string
    details?: unknown
  }
}

export interface WorkerEvent {
  protocol_version: 1
  request_id: string
  event: string
  task_id?: string
  progress?: TaskProgress
  result?: TaskResult & {
    transcript_path: string
    transcript_id: string
    warnings?: string[]
    peak_memory_mb?: number | null
  }
  error?: {
    code: string
    message: string
    stage?: string
    details?: unknown
    resumable?: boolean
  }
  status?: string
  message?: string
  data?: unknown
}

export interface WorkerInitResult {
  worker_version: string
  protocol_version: number
  python_version: string
  platform: string
  ffmpeg: {
    available: boolean
    version: string | null
  }
  device: {
    requested: string
    selected: string
    torch: string | null
    cuda: boolean
    mps: boolean
    reason: string
  }
  models: Array<{
    id: string
    path: string
    installed: boolean
    bytes: number
  }>
  model_loaded: string | null
}

export interface WorkerStatusResult {
  pid: number
  uptime_seconds: number
  device: string
  model_loaded: string | null
  aligner_loaded: string | null
  running_task_id: string | null
  queued_tasks: number
  peak_memory_mb: number | null
  last_error: string | null
}

export interface TranscribeParams {
  task_id: string
  file_path: string
  source_sha256: string
  project_id: string
  transcript_id: string
  transcript_path: string
  task_dir: string
  model: string
  model_path: string
  aligner_model: string | null
  aligner_model_path: string | null
  language: string
  align: boolean
  context: string
  device: string
  dtype: string
  max_chunk_seconds: number
  max_new_tokens: number
  vad: {
    threshold_db: number | null
    min_silence_ms: number
    min_speech_ms: number
    padding_ms: number
    max_gap_ms: number
    frame_ms: number
  }
  resume: boolean
  keep_temp_files: boolean
}
