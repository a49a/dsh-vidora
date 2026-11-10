import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, int, num, obj, str, text } from './shared.js'
import { resolveTranscript } from './resolve.js'
import { findSegments } from '../core/transcript.js'
import { formatClock } from '../core/time.js'

export function createGetTranscriptTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_get_transcript',
    description: [
      'Read a slice of a completed local Vidora transcript with stable segment ids and timestamps.',
      'Use this only when the current Harness model is explicitly trusted as local; the tool is hidden otherwise.',
      'Prefer range/paging parameters instead of requesting the entire long transcript.',
    ].join(' '),
    parameters: obj({
      transcriptId: str('Transcript id. Omit to use the latest transcript in projectId.'),
      projectId: str('Project id. Required when transcriptId is omitted.'),
      startMs: num('Only segments overlapping this start time (milliseconds).'),
      endMs: num('Only segments overlapping this end time (milliseconds).'),
      offset: int('Paging offset within the matching segments.', { minimum: 0 }),
      limit: int('Maximum segments to return (default 50, max 500).', { minimum: 1, maximum: 500 }),
      includeWords: bool('Include word/character timestamps when alignment produced them.'),
      maxChars: int('Maximum returned transcript characters (default 12000, max 40000).', { minimum: 1000, maximum: 40000 }),
    }),
    output: {
      schema: obj({
        transcript_id: str('Transcript id.'),
        project_id: str('Project id.'),
        source_path: str('Local source path.'),
        duration_ms: num('Source duration.'),
        model: str('ASR model id.'),
        language: str('Detected/forced language.'),
        total_segments: num('Total matching segments.'),
        offset: num('Returned offset.'),
        limit: num('Requested limit.'),
        returned: num('Returned segment count.'),
        truncated: bool('True when maxChars cut the result.'),
        segments: arr('Segments', obj({
          id: str('Stable segment id.'),
          start_ms: num('Start milliseconds.'),
          end_ms: num('End milliseconds.'),
          time: str('Human-readable start time.'),
          text: str('Transcript text.'),
          timing_status: str('aligned, chunk, or uncertain.'),
          words: arr('Word timestamps', obj({
            text: str('Word/character text.'),
            start_ms: num('Start milliseconds.'),
            end_ms: num('End milliseconds.'),
          }, ['text', 'start_ms', 'end_ms'])),
        }, ['id', 'start_ms', 'end_ms', 'time', 'text', 'timing_status', 'words'])),
      }, [
        'transcript_id', 'project_id', 'source_path', 'duration_ms', 'model', 'language',
        'total_segments', 'offset', 'limit', 'returned', 'truncated', 'segments',
      ]),
      render(_args, value) {
        const lines = [
          `转写稿：${String(value.transcript_id)}（${String(value.model)}，${String(value.language)}）`,
          `来源：${String(value.source_path)}`,
          `片段：${String(value.returned)}/${String(value.total_segments)}，offset ${String(value.offset)}`,
        ]
        const segments = Array.isArray(value.segments) ? value.segments : []
        for (const segment of segments) {
          const record = segment as Record<string, unknown>
          lines.push(`[${String(record.time)}] (${String(record.id)}, ${String(record.timing_status)}) ${String(record.text)}`)
        }
        if (value.truncated === true) lines.push('结果已按 maxChars 截断；请继续使用 offset/时间范围分页。')
        return text(lines.join('\n'))
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Vidora 读取转写',
        kind: 'read',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      await runtime.ready()
      runtime.privacy.assertContentReadAllowed(exec.agent)
      const transcript = await resolveTranscript(runtime, args)
      const startMs = typeof args.startMs === 'number' ? args.startMs : undefined
      const endMs = typeof args.endMs === 'number' ? args.endMs : undefined
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 50
      const maxChars = typeof args.maxChars === 'number' ? Math.max(1000, Math.min(40_000, Math.floor(args.maxChars))) : 12_000
      const includeWords = args.includeWords === true
      const result = findSegments(transcript, { startMs, endMs, offset, limit })
      let used = 0
      let truncated = false
      const segments: Array<Record<string, unknown>> = []
      for (const segment of result.segments) {
        if (used + segment.text.length > maxChars && segments.length > 0) {
          truncated = true
          break
        }
        used += segment.text.length
        segments.push({
          id: segment.id,
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          time: formatClock(segment.start_ms),
          text: segment.text,
          timing_status: segment.timing_status,
          words: includeWords
            ? (segment.words ?? []).map(word => ({
              text: word.text,
              start_ms: word.start_ms,
              end_ms: word.end_ms,
            }))
            : [],
        })
      }
      return {
        transcript_id: transcript.id,
        project_id: transcript.project_id,
        source_path: transcript.source.path,
        duration_ms: transcript.source.duration_ms,
        model: transcript.model,
        language: transcript.language,
        total_segments: result.total,
        offset: result.offset,
        limit: result.limit,
        returned: segments.length,
        truncated,
        segments,
      }
    },
  }
}
