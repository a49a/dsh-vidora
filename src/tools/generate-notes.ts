import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, enumStr, num, obj, str, text } from './shared.js'
import { resolveTranscript } from './resolve.js'
import type { DocumentMode } from '../core/types.js'

export function createGenerateNotesTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_generate_notes',
    description: [
      'Generate a Markdown teaching document from an existing local Vidora transcript using a confirmed local LLM.',
      'The transcript is processed in windows; the LLM output is validated and only real transcript segment ids become citations.',
      'ASR is never re-run. No cloud model is used and no automatic fallback exists.',
      'The tool returns metadata and a local file path, not the document body. Under an untrusted remote session, titles and warnings are withheld.',
    ].join(' '),
    parameters: obj({
      transcriptId: str('Transcript id. Omit to use the latest transcript in projectId.'),
      projectId: str('Project id. Required when transcriptId is omitted.'),
      mode: enumStr('Document mode.', ['concise', 'detailed', 'transcript', 'review']),
      title: str('Optional document title override.'),
      force: bool('Regenerate even when an identical local document already exists.'),
    }),
    output: {
      schema: obj({
        document_id: str('Document id.'),
        project_id: str('Project id.'),
        transcript_id: str('Transcript id.'),
        mode: str('Document mode.'),
        title: str('Document title, or empty when the current session is untrusted.'),
        version_number: num('Version number for this transcript/mode.'),
        markdown_path: str('Local Markdown path.'),
        section_count: num('Number of section blocks.'),
        cited_segments: num('Distinct transcript segments cited.'),
        citation_count: num('Total citation occurrences including key terms.'),
        invalid_citations: num('Citations rejected because the segment did not exist.'),
        warnings: arr('Warnings (sanitized under an untrusted session)', str('Warning')),
        cached: bool('True when an equivalent document was reused.'),
        llm_provider: str('ollama, openai-compatible, or harness.'),
        llm_model: str('Local model id.'),
        llm_local: bool('Whether the adapter asserts a local endpoint.'),
        session_trusted: bool('Whether the current Harness session model is trusted as local.'),
      }, [
        'document_id', 'project_id', 'transcript_id', 'mode', 'title', 'version_number',
        'markdown_path', 'section_count', 'cited_segments', 'citation_count',
        'invalid_citations', 'warnings', 'cached', 'llm_provider', 'llm_model',
        'llm_local', 'session_trusted',
      ]),
      render(_args, value) {
        const lines = [
          `Vidora 讲义已生成：${String(value.document_id)}（${String(value.mode)} v${String(value.version_number)}）`,
          `文件：${String(value.markdown_path)}`,
        ]
        if (value.title) lines.push(`标题：${String(value.title)}`)
        lines.push(`章节：${String(value.section_count)}；引用 ${String(value.cited_segments)} 个不同片段（共 ${String(value.citation_count)} 次）`)
        lines.push(`本地模型：${String(value.llm_provider)} / ${String(value.llm_model)}`)
        if (value.cached === true) lines.push('命中已有讲义版本，未重新调用本地模型。')
        if (value.session_trusted !== true) {
          lines.push('当前会话模型未列入本地信任列表：正文、标题和警告不会返回给该模型；请在本机打开文件。')
        }
        const warnings = Array.isArray(value.warnings) ? value.warnings : []
        for (const warning of warnings.slice(0, 4)) lines.push(`提示：${String(warning)}`)
        return text(lines.join('\n'))
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Vidora 生成本地讲义',
        kind: 'other',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      await runtime.ready()
      if (!runtime.llmClient()) {
        throw new Error(
          '未配置本地 LLM。ASR 和导出仍可用；请设置 llm.mode=ollama/openai/harness 后重试。',
        )
      }
      const transcript = await resolveTranscript(runtime, args)
      const mode = normalizeMode(args.mode, runtime.config.document.defaultMode)
      const sessionTrusted = runtime.privacy.isCurrentSessionTrusted(exec.agent)
      const titleOverride = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
      let result
      try {
        result = await runtime.documents().generate({
          transcript,
          mode,
          ...(titleOverride ? { title: titleOverride } : {}),
          ...(args.force === true ? { force: true } : {}),
          signal: exec.signal,
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const code = typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'NOTES_FAILED'
        if (!sessionTrusted) {
          throw new Error(`本地讲义生成失败（${code}）；为避免正文外传，详情仅写入本机日志。`)
        }
        throw error
      }
      const document = result.document
      const sectionCount = document.blocks.filter(block => block.type === 'section').length
      const cited = new Set(document.blocks.flatMap(block => block.source_segment_ids))
      const citedCount = cited.size
      const totalCitationCount = document.blocks.reduce((sum, block) => sum + block.source_segment_ids.length, 0)
      const warnings = sessionTrusted
        ? document.warnings
        : ['本地讲义已生成；当前会话不可信，警告与章节标题已隐藏。']
      return {
        document_id: document.id,
        project_id: document.project_id,
        transcript_id: document.transcript_id,
        mode: document.mode,
        title: sessionTrusted ? document.title : '',
        version_number: document.version_number,
        markdown_path: result.markdownPath,
        section_count: sectionCount,
        cited_segments: citedCount,
        citation_count: totalCitationCount,
        invalid_citations: document.stats.invalid_citations,
        warnings,
        cached: result.cached,
        llm_provider: document.llm.provider,
        llm_model: document.llm.model,
        llm_local: document.llm.local,
        session_trusted: sessionTrusted,
      }
    },
  }
}

function normalizeMode(value: unknown, fallback: DocumentMode): DocumentMode {
  if (value === 'concise' || value === 'detailed' || value === 'transcript' || value === 'review') {
    return value
  }
  return fallback
}
