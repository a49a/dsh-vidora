import { basename, dirname, join, relative, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import type { VidoraConfig } from '../config.js'
import type {
  DocumentMode,
  ExportFormat,
  Transcript,
  VidoraDocument,
} from '../core/types.js'
import type { DataStore } from '../storage/data-store.js'
import { atomicWriteFile, pathExists } from '../core/fs.js'
import { renderDocumentMarkdown, renderTranscriptMarkdown, renderTranscriptTxt } from '../core/markdown.js'
import { renderSrt } from '../core/srt.js'
import { shortHash } from '../core/hash.js'
import { NotesEngine, NotesGenerationError, NOTES_PROMPT_VERSION } from './notes-engine.js'
import type { LocalLlmClient } from './local-llm.js'

export class DocumentServiceError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'DocumentServiceError'
    this.code = code
  }
}

export interface GenerateNotesRequest {
  transcript: Transcript
  mode: DocumentMode
  title?: string
  force?: boolean
  signal?: AbortSignal
}

export interface GenerateNotesResult {
  document: VidoraDocument
  markdownPath: string
  cached: boolean
}

export interface ExportRequest {
  format: ExportFormat
  transcript?: Transcript
  document?: VidoraDocument
  outputPath?: string
  overwrite?: boolean
  includeTimestamps?: boolean
}

export interface ExportResult {
  path: string
  format: ExportFormat
  bytes: number
  kind: 'document' | 'transcript'
}

export class DocumentService {
  constructor(
    private readonly config: VidoraConfig,
    private readonly store: DataStore,
    private readonly client: LocalLlmClient | null,
  ) {}

  async generate(request: GenerateNotesRequest): Promise<GenerateNotesResult> {
    if (!this.client) {
      throw new DocumentServiceError(
        '未配置本地 LLM，无法生成 AI 讲义。ASR 转写和导出仍然可用。请配置 llm.mode 为 ollama/openai/harness。',
        'LOCAL_LLM_NOT_CONFIGURED',
      )
    }
    const transcript = request.transcript
    const existing = await this.store.listDocuments(transcript.project_id)
    const candidates = existing
      .filter(document => (
        document.transcript_id === transcript.id
        && document.mode === request.mode
        && document.llm.provider === this.client!.info.provider
        && document.llm.model === this.client!.info.model
        && document.llm.prompt_version === NOTES_PROMPT_VERSION
      ))
      .sort((a, b) => b.version_number - a.version_number)
    if (!request.force && candidates.length > 0) {
      const latest = candidates[0]!
      if (!request.title || request.title.trim() === latest.title) {
        const markdown = renderDocumentMarkdown(latest, transcript, {
          includeFrontMatter: this.config.document.includeFrontMatter,
          transcriptHref: this.relativeTranscriptHref(this.store.notePath(transcript.project_id, latest.id), transcript),
        })
        await this.store.saveDocument(latest, markdown)
        return { document: latest, markdownPath: this.store.notePath(transcript.project_id, latest.id), cached: true }
      }
    }

    const engine = new NotesEngine(this.config.document, this.client)
    const generated = await engine.generate({
      transcript,
      mode: request.mode,
      ...(request.title ? { title: request.title } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    const versionNumber = (candidates[0]?.version_number ?? 0) + 1
    const document: VidoraDocument = {
      ...generated.document,
      version_number: versionNumber,
      id: `doc-${shortHash(`${transcript.id}:${request.mode}:${versionNumber}:${Date.now()}`, 20)}`,
    }
    document.stats = {
      ...document.stats,
      invalid_citations: generated.document.stats.invalid_citations,
    }
    const markdown = renderDocumentMarkdown(document, transcript, {
      includeFrontMatter: this.config.document.includeFrontMatter,
      transcriptHref: this.relativeTranscriptHref(this.store.notePath(transcript.project_id, document.id), transcript),
    })
    await this.store.saveDocument(document, markdown)
    return {
      document,
      markdownPath: this.store.notePath(transcript.project_id, document.id),
      cached: false,
    }
  }

  async readDocument(
    projectId: string,
    documentId?: string,
  ): Promise<{ document: VidoraDocument; markdown: string } | undefined> {
    const document = documentId
      ? await this.store.loadDocument(projectId, documentId)
      : await this.store.latestDocument(projectId)
    if (!document) return undefined
    const path = this.store.notePath(projectId, document.id)
    let markdown: string
    if (await pathExists(path)) {
      const { readFile } = await import('node:fs/promises')
      markdown = await readFile(path, 'utf8')
    } else {
      const transcript = await this.store.loadTranscript(projectId, document.transcript_id)
      markdown = renderDocumentMarkdown(document, transcript, {
        includeFrontMatter: this.config.document.includeFrontMatter,
        transcriptHref: this.relativeTranscriptHref(path, transcript),
      })
      await this.store.saveDocument(document, markdown)
    }
    return { document, markdown }
  }

  async export(request: ExportRequest): Promise<ExportResult> {
    let transcript = request.transcript
    let document = request.document
    if (!transcript && document) {
      transcript = await this.store.loadTranscript(document.project_id, document.transcript_id)
    }
    if (!transcript) {
      throw new DocumentServiceError('导出需要 transcript 或 document', 'EXPORT_INPUT_MISSING')
    }
    const projectId = transcript.project_id
    if (document && document.project_id !== projectId) {
      throw new DocumentServiceError('document 与 transcript 不属于同一个项目', 'EXPORT_PROJECT_MISMATCH')
    }
    const format = request.format
    const kind: 'document' | 'transcript' = document ? 'document' : 'transcript'
    const sourceName = basename(transcript.source.path)
    const base = document
      ? this.store.exportNameFor(document, sourceName)
      : `${stripExtension(sourceName)}-transcript`
    const target = request.outputPath
      ? await this.validateOutputPath(request.outputPath)
      : join(this.store.exportsDir(projectId), `${base}.${format}`)
    if (!request.overwrite && await pathExists(target)) {
      throw new DocumentServiceError(
        `导出目标已存在：${target}。设置 overwrite=true 可覆盖。`,
        'EXPORT_EXISTS',
      )
    }

    let data: string
    if (format === 'json') {
      data = `${JSON.stringify(document ?? transcript, null, 2)}\n`
    } else if (format === 'srt') {
      data = renderSrt(transcript)
    } else if (format === 'txt') {
      data = renderTranscriptTxt(transcript, request.includeTimestamps !== false)
      if (document) data = `# ${document.title}\n\n${data}`
    } else if (format === 'md') {
      if (document) {
        data = renderDocumentMarkdown(document, transcript, {
          includeFrontMatter: this.config.document.includeFrontMatter,
          transcriptHref: this.relativeTranscriptHref(target, transcript),
        })
      } else {
        data = renderTranscriptMarkdown(transcript, {
          includeFrontMatter: this.config.document.includeFrontMatter,
        })
      }
    } else {
      throw new DocumentServiceError(`不支持的导出格式：${format}`, 'EXPORT_FORMAT_UNSUPPORTED')
    }
    await atomicWriteFile(target, data)
    const info = await stat(target)
    return { path: target, format, bytes: info.size, kind }
  }

  private async validateOutputPath(outputPath: string): Promise<string> {
    const { resolveOutputPath } = await import('./security.js')
    return await resolveOutputPath(outputPath, this.config.paths, this.config.dataDir)
  }

  private relativeTranscriptHref(fromFile: string, transcript: Transcript): string {
    const target = this.store.transcriptPath(transcript.project_id, transcript.id)
    const rel = relative(dirname(fromFile), target)
    return rel.split(sep).join('/')
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

export { NotesGenerationError }
