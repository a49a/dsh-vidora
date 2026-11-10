import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { bool, enumStr, num, obj, str, text } from './shared.js'
import { resolveDocument, resolveTranscript } from './resolve.js'
import type { ExportFormat, Transcript, VidoraDocument } from '../core/types.js'

export function createExportTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_export',
    description: [
      'Export a local Vidora transcript or document as Markdown, JSON, TXT, or SRT.',
      'This tool writes files and returns only path/size metadata; it never returns the document body, so it is safe under a remote Harness session.',
      'Default output is the project exports/ directory; pass outputPath to choose a location.',
    ].join(' '),
    parameters: obj({
      transcriptId: str('Transcript id to export.'),
      documentId: str('Document id to export.'),
      projectId: str('Project id. When no id is given, uses the latest document/transcript in this project.'),
      format: enumStr('Output format.', ['md', 'json', 'txt', 'srt']),
      outputPath: str('Optional output path. Relative paths resolve from the current working directory.'),
      overwrite: bool('Overwrite an existing file (default false).'),
      includeTimestamps: bool('For TXT, include [mm:ss] timestamps (default true).'),
    }, ['format']),
    output: {
      schema: obj({
        path: str('Local output path.'),
        format: str('Export format.'),
        bytes: num('File size in bytes.'),
        kind: str('document or transcript.'),
        project_id: str('Project id.'),
        transcript_id: str('Transcript id used.'),
        document_id: str('Document id used, or empty.'),
      }, ['path', 'format', 'bytes', 'kind', 'project_id', 'transcript_id', 'document_id']),
      render(_args, value) {
        return text([
          `Vidora 导出完成：${String(value.path)}`,
          `格式：${String(value.format)}；大小：${String(value.bytes)} 字节；来源：${String(value.kind)}`,
          `项目：${String(value.project_id)}；转写稿：${String(value.transcript_id)}`,
        ].join('\n'))
      },
    },
    presentCall(args) {
      if (typeof args.outputPath !== 'string') return undefined
      return {
        card: 'generic',
        title: 'Vidora 导出',
        kind: 'edit',
        rawInput: args,
        locations: [{ path: args.outputPath }],
      }
    },
    async execute(args) {
      await runtime.ready()
      const format = normalizeFormat(args.format)
      let transcript: Transcript | undefined
      let document: VidoraDocument | undefined
      const transcriptId = typeof args.transcriptId === 'string' ? args.transcriptId.trim() : ''
      const documentId = typeof args.documentId === 'string' ? args.documentId.trim() : ''
      const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : ''
      if (documentId) {
        document = await resolveDocument(runtime, { documentId, ...(projectId ? { projectId } : {}) })
        if (transcriptId) {
          transcript = await resolveTranscript(runtime, { transcriptId, projectId: document.project_id })
        } else {
          transcript = await runtime.store.loadTranscript(document.project_id, document.transcript_id)
        }
      } else if (transcriptId) {
        transcript = await resolveTranscript(runtime, { transcriptId, ...(projectId ? { projectId } : {}) })
      } else if (projectId) {
        document = await runtime.store.latestDocument(projectId)
        if (document) {
          transcript = await runtime.store.loadTranscript(projectId, document.transcript_id)
        } else {
          transcript = await resolveTranscript(runtime, { projectId })
        }
      } else {
        throw new Error('请提供 documentId、transcriptId 或 projectId')
      }
      const result = await runtime.documents().export({
        format,
        ...(transcript ? { transcript } : {}),
        ...(document ? { document } : {}),
        ...(typeof args.outputPath === 'string' && args.outputPath.trim() ? { outputPath: args.outputPath } : {}),
        ...(args.overwrite === true ? { overwrite: true } : {}),
        ...(typeof args.includeTimestamps === 'boolean' ? { includeTimestamps: args.includeTimestamps } : {}),
      })
      return {
        path: result.path,
        format: result.format,
        bytes: result.bytes,
        kind: result.kind,
        project_id: transcript?.project_id ?? document?.project_id ?? '',
        transcript_id: transcript?.id ?? document?.transcript_id ?? '',
        document_id: document?.id ?? '',
      }
    },
  }
}

function normalizeFormat(value: unknown): ExportFormat {
  if (value === 'md' || value === 'json' || value === 'txt' || value === 'srt') return value
  throw new Error('format must be one of md, json, txt, srt')
}
