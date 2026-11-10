import type { VidoraRuntime } from '../services/runtime.js'
import type { VidoraToolDefinition } from './types.js'
import { arr, bool, int, num, obj, str, text } from './shared.js'
import { resolveDocument } from './resolve.js'

export function createGetDocumentTool(runtime: VidoraRuntime): VidoraToolDefinition {
  return {
    name: 'vidora_get_document',
    description: [
      'Read a local Vidora Markdown document and its source mapping.',
      'Available only when the current Harness model is explicitly trusted as local; it is hidden otherwise.',
      'Use includeMarkdown=false for metadata, or request a bounded character window of the Markdown.',
    ].join(' '),
    parameters: obj({
      documentId: str('Document id. Omit to use the latest document in projectId.'),
      projectId: str('Project id. Required when documentId is omitted.'),
      includeMarkdown: bool('Return a bounded Markdown excerpt (default false).'),
      offset: int('Character offset for the Markdown excerpt.', { minimum: 0 }),
      limit: int('Maximum excerpt characters (default 12000, max 30000).', { minimum: 500, maximum: 30000 }),
    }),
    output: {
      schema: obj({
        document_id: str('Document id.'),
        project_id: str('Project id.'),
        transcript_id: str('Transcript id.'),
        mode: str('Document mode.'),
        title: str('Document title.'),
        version_number: num('Version number.'),
        created_at: str('Creation time.'),
        markdown_path: str('Local Markdown path.'),
        block_count: num('Block count.'),
        markdown_chars: num('Total Markdown characters.'),
        markdown_excerpt: str('Bounded Markdown excerpt, or empty.'),
        truncated: bool('Whether the excerpt is partial.'),
        warnings: arr('Warnings', str('Warning')),
      }, [
        'document_id', 'project_id', 'transcript_id', 'mode', 'title', 'version_number',
        'created_at', 'markdown_path', 'block_count', 'markdown_chars', 'markdown_excerpt',
        'truncated', 'warnings',
      ]),
      render(_args, value) {
        const lines = [
          `讲义：${String(value.document_id)}（${String(value.mode)} v${String(value.version_number)}）`,
          `标题：${String(value.title)}`,
          `文件：${String(value.markdown_path)}`,
          `章节块：${String(value.block_count)}；Markdown 字符数：${String(value.markdown_chars)}`,
        ]
        if (value.markdown_excerpt) {
          lines.push('---')
          lines.push(String(value.markdown_excerpt))
          if (value.truncated === true) lines.push('---\n（已截断；请使用 offset/limit 继续读取）')
        }
        return text(lines.join('\n'))
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Vidora 读取讲义',
        kind: 'read',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      await runtime.ready()
      runtime.privacy.assertContentReadAllowed(exec.agent)
      const document = await resolveDocument(runtime, args)
      const result = await runtime.documents().readDocument(document.project_id, document.id)
      if (!result) throw new Error(`找不到讲义：${document.id}`)
      const markdown = result.markdown
      const include = args.includeMarkdown === true
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
      const limit = typeof args.limit === 'number' ? Math.max(500, Math.min(30_000, Math.floor(args.limit))) : 12_000
      const excerpt = include ? markdown.slice(offset, offset + limit) : ''
      return {
        document_id: document.id,
        project_id: document.project_id,
        transcript_id: document.transcript_id,
        mode: document.mode,
        title: document.title,
        version_number: document.version_number,
        created_at: document.created_at,
        markdown_path: result ? runtime.store.notePath(document.project_id, document.id) : '',
        block_count: document.blocks.length,
        markdown_chars: markdown.length,
        markdown_excerpt: excerpt,
        truncated: include ? offset + excerpt.length < markdown.length : false,
        warnings: document.warnings,
      }
    },
  }
}
