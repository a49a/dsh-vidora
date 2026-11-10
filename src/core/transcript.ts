import type {
  DocumentBlock,
  Transcript,
  TranscriptSegment,
  VidoraDocument,
} from './types.js'
import { DOCUMENT_SCHEMA_VERSION, TRANSCRIPT_SCHEMA_VERSION } from './types.js'
import { formatClock } from './time.js'

export class DataValidationError extends Error {
  readonly code: string

  constructor(message: string, code = 'INVALID_DATA') {
    super(message)
    this.name = 'DataValidationError'
    this.code = code
  }
}

export function parseTranscript(value: unknown): Transcript {
  const root = expectObject(value, 'transcript')
  if (root.version !== TRANSCRIPT_SCHEMA_VERSION) {
    throw new DataValidationError(`Unsupported transcript version: ${String(root.version)}`, 'UNSUPPORTED_VERSION')
  }
  const id = expectString(root.id, 'transcript.id')
  const projectId = expectString(root.project_id, 'transcript.project_id')
  const source = expectObject(root.source, 'transcript.source')
  const modelInfo = expectObject(root.model_info, 'transcript.model_info')
  const params = expectObject(root.params, 'transcript.params')
  const stats = expectObject(root.stats, 'transcript.stats')
  const segments = expectArray(root.segments, 'transcript.segments').map((item, index) => parseSegment(item, index))
  ensureUniqueSegmentIds(segments)
  ensureOrderedSegments(segments)

  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    id,
    project_id: projectId,
    source: {
      path: expectString(source.path, 'transcript.source.path'),
      duration_ms: expectNumber(source.duration_ms, 'transcript.source.duration_ms'),
      sha256: expectString(source.sha256, 'transcript.source.sha256'),
      size_bytes: expectNumber(source.size_bytes, 'transcript.source.size_bytes'),
      container: optionalString(source.container),
      audio_codec: optionalString(source.audio_codec),
      sample_rate: optionalNumber(source.sample_rate),
      channels: optionalNumber(source.channels),
    },
    model: expectString(root.model, 'transcript.model'),
    model_info: {
      id: expectString(modelInfo.id, 'transcript.model_info.id'),
      repo: optionalString(modelInfo.repo),
      revision: optionalString(modelInfo.revision),
      backend: expectString(modelInfo.backend, 'transcript.model_info.backend'),
      device: expectString(modelInfo.device, 'transcript.model_info.device'),
      dtype: expectString(modelInfo.dtype, 'transcript.model_info.dtype'),
      package_version: optionalString(modelInfo.package_version),
      aligner: optionalString(modelInfo.aligner),
    },
    language: expectString(root.language, 'transcript.language'),
    created_at: expectString(root.created_at, 'transcript.created_at'),
    params: {
      language: expectString(params.language, 'transcript.params.language'),
      align: expectBoolean(params.align, 'transcript.params.align'),
      context: optionalString(params.context) ?? '',
      max_chunk_seconds: expectNumber(params.max_chunk_seconds, 'transcript.params.max_chunk_seconds'),
      vad: parseVad(params.vad),
      pipeline_version: expectNumber(params.pipeline_version, 'transcript.params.pipeline_version'),
    },
    segments,
    stats: {
      segment_count: expectNumber(stats.segment_count, 'transcript.stats.segment_count'),
      speech_duration_ms: expectNumber(stats.speech_duration_ms, 'transcript.stats.speech_duration_ms'),
      processing_ms: expectNumber(stats.processing_ms, 'transcript.stats.processing_ms'),
      peak_memory_mb: optionalNumber(stats.peak_memory_mb) ?? null,
      realtime_factor: optionalNumber(stats.realtime_factor) ?? null,
      completed_chunks: expectNumber(stats.completed_chunks, 'transcript.stats.completed_chunks'),
      total_chunks: expectNumber(stats.total_chunks, 'transcript.stats.total_chunks'),
    },
    warnings: optionalStringArray(root.warnings) ?? [],
  }
}

function parseSegment(value: unknown, index: number): TranscriptSegment {
  const segment = expectObject(value, `transcript.segments[${index}]`)
  const start = expectNumber(segment.start_ms, `transcript.segments[${index}].start_ms`)
  const end = expectNumber(segment.end_ms, `transcript.segments[${index}].end_ms`)
  if (end < start) {
    throw new DataValidationError(`Segment ${index} ends before it starts`, 'INVALID_TIME_RANGE')
  }
  const timing = segment.timing_status
  if (timing !== 'aligned' && timing !== 'chunk' && timing !== 'uncertain') {
    throw new DataValidationError(`Segment ${index} has an invalid timing_status`, 'INVALID_TIMING_STATUS')
  }
  const speaker = segment.speaker_id
  if (speaker !== null && speaker !== undefined && typeof speaker !== 'string') {
    throw new DataValidationError(`Segment ${index} has an invalid speaker_id`, 'INVALID_SPEAKER')
  }
  return {
    id: expectString(segment.id, `transcript.segments[${index}].id`),
    start_ms: start,
    end_ms: end,
    text: expectString(segment.text, `transcript.segments[${index}].text`),
    speaker_id: typeof speaker === 'string' ? speaker : null,
    timing_status: timing,
    words: parseWords(segment.words, index),
  }
}

function parseWords(value: unknown, segmentIndex: number): TranscriptSegment['words'] {
  if (value === undefined || value === null) return undefined
  const words = expectArray(value, `transcript.segments[${segmentIndex}].words`)
  return words.map((item, index) => {
    const word = expectObject(item, `transcript.segments[${segmentIndex}].words[${index}]`)
    const start = expectNumber(word.start_ms, `transcript.segments[${segmentIndex}].words[${index}].start_ms`)
    const end = expectNumber(word.end_ms, `transcript.segments[${segmentIndex}].words[${index}].end_ms`)
    if (end < start) {
      throw new DataValidationError(`Word ${index} ends before it starts`, 'INVALID_TIME_RANGE')
    }
    return {
      text: expectString(word.text, `transcript.segments[${segmentIndex}].words[${index}].text`),
      start_ms: start,
      end_ms: end,
      confidence: optionalNumber(word.confidence),
    }
  })
}

function parseVad(value: unknown) {
  const vad = expectObject(value, 'transcript.params.vad')
  return {
    threshold_db: optionalNumber(vad.threshold_db) ?? null,
    min_silence_ms: expectNumber(vad.min_silence_ms, 'transcript.params.vad.min_silence_ms'),
    min_speech_ms: expectNumber(vad.min_speech_ms, 'transcript.params.vad.min_speech_ms'),
    padding_ms: expectNumber(vad.padding_ms, 'transcript.params.vad.padding_ms'),
    max_gap_ms: expectNumber(vad.max_gap_ms, 'transcript.params.vad.max_gap_ms'),
    frame_ms: expectNumber(vad.frame_ms, 'transcript.params.vad.frame_ms'),
  }
}

export function parseDocument(value: unknown): VidoraDocument {
  const root = expectObject(value, 'document')
  if (root.version !== DOCUMENT_SCHEMA_VERSION) {
    throw new DataValidationError(`Unsupported document version: ${String(root.version)}`, 'UNSUPPORTED_VERSION')
  }
  const llm = expectObject(root.llm, 'document.llm')
  const stats = expectObject(root.stats, 'document.stats')
  const blocks = expectArray(root.blocks, 'document.blocks').map((item, index) => parseBlock(item, index))
  const mode = root.mode
  if (mode !== 'concise' && mode !== 'detailed' && mode !== 'transcript' && mode !== 'review') {
    throw new DataValidationError('document.mode is invalid', 'INVALID_MODE')
  }
  return {
    version: DOCUMENT_SCHEMA_VERSION,
    id: expectString(root.id, 'document.id'),
    project_id: expectString(root.project_id, 'document.project_id'),
    transcript_id: expectString(root.transcript_id, 'document.transcript_id'),
    mode,
    title: expectString(root.title, 'document.title'),
    language: expectString(root.language, 'document.language'),
    created_at: expectString(root.created_at, 'document.created_at'),
    version_number: expectNumber(root.version_number, 'document.version_number'),
    llm: {
      provider: expectString(llm.provider, 'document.llm.provider') as 'ollama' | 'openai-compatible' | 'harness',
      model: expectString(llm.model, 'document.llm.model'),
      endpoint: optionalString(llm.endpoint),
      local: expectBoolean(llm.local, 'document.llm.local'),
      prompt_version: expectString(llm.prompt_version, 'document.llm.prompt_version'),
    },
    blocks,
    stats: {
      source_segments: expectNumber(stats.source_segments, 'document.stats.source_segments'),
      cited_segments: expectNumber(stats.cited_segments, 'document.stats.cited_segments'),
      invalid_citations: expectNumber(stats.invalid_citations, 'document.stats.invalid_citations'),
      windows: expectNumber(stats.windows, 'document.stats.windows'),
      llm_calls: expectNumber(stats.llm_calls, 'document.stats.llm_calls'),
      duration_ms: expectNumber(stats.duration_ms, 'document.stats.duration_ms'),
    },
    warnings: optionalStringArray(root.warnings) ?? [],
  }
}

function parseBlock(value: unknown, index: number): DocumentBlock {
  const block = expectObject(value, `document.blocks[${index}]`)
  const type = block.type
  if (!['section', 'paragraph', 'list', 'code', 'formula', 'callout', 'key_terms'].includes(String(type))) {
    throw new DataValidationError(`document.blocks[${index}].type is invalid`, 'INVALID_BLOCK_TYPE')
  }
  return {
    id: expectString(block.id, `document.blocks[${index}].id`),
    type: type as DocumentBlock['type'],
    level: optionalNumber(block.level),
    title: optionalString(block.title),
    content: expectString(block.content, `document.blocks[${index}].content`),
    source_segment_ids: optionalStringArray(block.source_segment_ids) ?? [],
    uncertain: block.uncertain === true ? true : undefined,
  }
}

export function segmentMap(transcript: Transcript): Map<string, TranscriptSegment> {
  return new Map(transcript.segments.map(segment => [segment.id, segment]))
}

export function transcriptText(transcript: Transcript): string {
  return transcript.segments.map(segment => segment.text).join('\n')
}

export function transcriptPlainText(transcript: Transcript, timestamps = true): string {
  if (!timestamps) {
    return `${transcript.segments.map(segment => segment.text).join('\n')}\n`
  }
  return `${transcript.segments
    .map(segment => `[${formatClock(segment.start_ms)}] ${segment.text}`)
    .join('\n')}\n`
}

export function findSegments(
  transcript: Transcript,
  options: { startMs?: number; endMs?: number; offset?: number; limit?: number },
): { segments: TranscriptSegment[]; total: number; offset: number; limit: number } {
  const start = options.startMs ?? 0
  const end = options.endMs ?? Number.MAX_SAFE_INTEGER
  const matching = transcript.segments.filter(segment => segment.end_ms >= start && segment.start_ms <= end)
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  return {
    segments: matching.slice(offset, offset + limit),
    total: matching.length,
    offset,
    limit,
  }
}

export function citationsFor(
  block: DocumentBlock,
  transcript: Transcript,
  transcriptHref: string,
): string {
  if (block.source_segment_ids.length === 0) return ''
  const byId = segmentMap(transcript)
  const links: string[] = []
  const seen = new Set<string>()
  for (const id of block.source_segment_ids) {
    const segment = byId.get(id)
    if (!segment || seen.has(id)) continue
    seen.add(id)
    links.push(`[${formatClock(segment.start_ms)}](${transcriptHref}#${encodeURIComponent(segment.id)})`)
  }
  if (links.length === 0) return ''
  const shown = links.slice(0, 8)
  const extra = links.length - shown.length
  return `来源：${shown.join(' · ')}${extra > 0 ? ` · 等 ${links.length} 段` : ''}`
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DataValidationError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new DataValidationError(`${path} must be an array`)
  return value
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new DataValidationError(`${path} must be a string`)
  return value
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataValidationError(`${path} must be a finite number`)
  }
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new DataValidationError(`${path} must be a boolean`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new DataValidationError('Expected an array of strings')
  }
  return value
}

function ensureUniqueSegmentIds(segments: TranscriptSegment[]): void {
  const seen = new Set<string>()
  for (const segment of segments) {
    if (!segment.id) throw new DataValidationError('Segment id must not be empty', 'EMPTY_SEGMENT_ID')
    if (seen.has(segment.id)) {
      throw new DataValidationError(`Duplicate segment id: ${segment.id}`, 'DUPLICATE_SEGMENT_ID')
    }
    seen.add(segment.id)
  }
}

function ensureOrderedSegments(segments: TranscriptSegment[]): void {
  let previousEnd = -1
  for (const segment of segments) {
    if (segment.start_ms < previousEnd) {
      // Multiple segments may share a boundary, but they may not overlap.
      throw new DataValidationError(`Segments overlap at ${segment.id}`, 'OVERLAPPING_SEGMENTS')
    }
    previousEnd = segment.end_ms
  }
}
