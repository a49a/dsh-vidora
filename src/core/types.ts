/**
 * Vidora Core shared contracts.
 *
 * These types intentionally have no dependency on DeepSeek Harness or Cordis.
 * A Chrome extension or a GPUI desktop shell can consume the same JSON files.
 */

export const TRANSCRIPT_SCHEMA_VERSION = 1 as const
export const DOCUMENT_SCHEMA_VERSION = 1 as const
export const TASK_SCHEMA_VERSION = 1 as const
export const PROTOCOL_VERSION = 1 as const

export type TimingStatus = 'aligned' | 'chunk' | 'uncertain'
export type DocumentMode = 'concise' | 'detailed' | 'transcript' | 'review'
export type ExportFormat = 'md' | 'json' | 'txt' | 'srt'
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type TaskStage =
  | 'preparing'
  | 'decoding'
  | 'segmenting'
  | 'transcribing'
  | 'aligning'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TranscriptWord {
  text: string
  start_ms: number
  end_ms: number
  /** Character/word alignment confidence when the backend provides it. */
  confidence?: number
}

export interface TranscriptSegment {
  id: string
  start_ms: number
  end_ms: number
  text: string
  speaker_id: string | null
  timing_status: TimingStatus
  /** Optional enhancement from Qwen3-ForcedAligner. */
  words?: TranscriptWord[]
}

export interface TranscriptSource {
  path: string
  duration_ms: number
  sha256: string
  size_bytes: number
  container?: string
  audio_codec?: string
  sample_rate?: number
  channels?: number
}

export interface TranscriptModelInfo {
  id: string
  repo?: string
  revision?: string
  backend: string
  device: string
  dtype: string
  package_version?: string
  aligner?: string
}

export interface TranscriptParams {
  language: string
  align: boolean
  context: string
  max_chunk_seconds: number
  vad: {
    threshold_db: number | null
    min_silence_ms: number
    min_speech_ms: number
    padding_ms: number
    max_gap_ms: number
    frame_ms: number
  }
  pipeline_version: number
}

export interface TranscriptStats {
  segment_count: number
  speech_duration_ms: number
  processing_ms: number
  peak_memory_mb: number | null
  realtime_factor: number | null
  completed_chunks: number
  total_chunks: number
}

export interface Transcript {
  version: typeof TRANSCRIPT_SCHEMA_VERSION
  id: string
  project_id: string
  source: TranscriptSource
  /** Stable short model id, e.g. qwen3-asr-0.6b. */
  model: string
  model_info: TranscriptModelInfo
  language: string
  created_at: string
  params: TranscriptParams
  segments: TranscriptSegment[]
  stats: TranscriptStats
  warnings: string[]
}

export type DocumentBlockType =
  | 'section'
  | 'paragraph'
  | 'list'
  | 'code'
  | 'formula'
  | 'callout'
  | 'key_terms'

export interface DocumentBlock {
  id: string
  type: DocumentBlockType
  level?: number
  title?: string
  content: string
  source_segment_ids: string[]
  uncertain?: boolean
}

export interface DocumentLlmInfo {
  provider: 'ollama' | 'openai-compatible' | 'harness'
  model: string
  endpoint?: string
  /** True only when the adapter verified/asserted a local endpoint. */
  local: boolean
  prompt_version: string
}

export interface DocumentStats {
  source_segments: number
  cited_segments: number
  invalid_citations: number
  windows: number
  llm_calls: number
  duration_ms: number
}

export interface VidoraDocument {
  version: typeof DOCUMENT_SCHEMA_VERSION
  id: string
  project_id: string
  transcript_id: string
  mode: DocumentMode
  title: string
  language: string
  created_at: string
  version_number: number
  llm: DocumentLlmInfo
  blocks: DocumentBlock[]
  stats: DocumentStats
  warnings: string[]
}

export interface SourceRecord {
  project_id: string
  path: string
  sha256: string
  size_bytes: number
  duration_ms: number | null
  container: string | null
  audio_codec: string | null
  sample_rate: number | null
  channels: number | null
  created_at: string
  updated_at: string
  transcript_ids: string[]
  document_ids: string[]
}

export interface TaskError {
  code: string
  message: string
  stage: TaskStage | null
}

export interface TaskProgress {
  stage: TaskStage
  processed_ms: number
  total_ms: number
  completed_chunks: number
  total_chunks: number
}

export interface TaskResult {
  transcript_id: string
  transcript_path: string
  duration_ms: number
  segment_count: number
  language: string
  model: string
  processing_ms: number
  peak_memory_mb: number | null
}

export interface VidoraTask {
  version: typeof TASK_SCHEMA_VERSION
  id: string
  status: TaskStatus
  stage: TaskStage
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  progress: TaskProgress
  source: {
    path: string
    sha256: string
    size_bytes: number
    duration_ms: number | null
  }
  project_id: string
  transcript_id: string
  params: TranscriptParams
  model: string
  aligner: string | null
  dedupe_key: string
  task_dir: string
  transcript_path: string
  worker_request_id: string | null
  error: TaskError | null
  result: TaskResult | null
  warnings: string[]
  resumable: boolean
}

export interface CacheEntry {
  dedupe_key: string
  project_id: string
  transcript_id: string
  source_sha256: string
  model: string
  params_hash: string
  transcript_path: string
  created_at: string
  segment_count: number
  duration_ms: number
}

export interface CacheIndex {
  version: 1
  entries: Record<string, CacheEntry>
}

export interface ProjectSummary {
  project_id: string
  source: SourceRecord
  transcripts: Array<Pick<Transcript, 'id' | 'created_at' | 'model' | 'language' | 'stats'>>
  documents: Array<Pick<VidoraDocument, 'id' | 'created_at' | 'mode' | 'title' | 'version_number'>>
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
