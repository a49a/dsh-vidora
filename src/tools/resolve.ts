import type { Transcript, VidoraDocument } from '../core/types.js'
import type { VidoraRuntime } from '../services/runtime.js'
import { optionalString } from './shared.js'

export class LookupError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'LookupError'
    this.code = code
  }
}

export async function resolveTranscript(
  runtime: VidoraRuntime,
  args: Record<string, unknown>,
): Promise<Transcript> {
  const transcriptId = optionalString(args.transcriptId)
  const projectId = optionalString(args.projectId)
  if (transcriptId && projectId) {
    return await runtime.store.loadTranscript(projectId, transcriptId)
  }
  if (transcriptId) {
    const found = await runtime.store.findTranscriptById(transcriptId)
    if (!found) throw new LookupError(`找不到转写稿：${transcriptId}`, 'TRANSCRIPT_NOT_FOUND')
    return found
  }
  if (projectId) {
    const latest = await runtime.store.latestTranscript(projectId)
    if (!latest) throw new LookupError(`项目没有转写稿：${projectId}`, 'TRANSCRIPT_NOT_FOUND')
    return latest
  }
  throw new LookupError('请提供 transcriptId 或 projectId', 'LOOKUP_ARGUMENT_MISSING')
}

export async function resolveDocument(
  runtime: VidoraRuntime,
  args: Record<string, unknown>,
): Promise<VidoraDocument> {
  const documentId = optionalString(args.documentId)
  const projectId = optionalString(args.projectId)
  if (documentId && projectId) {
    return await runtime.store.loadDocument(projectId, documentId)
  }
  if (documentId) {
    const found = await runtime.store.findDocumentById(documentId)
    if (!found) throw new LookupError(`找不到讲义：${documentId}`, 'DOCUMENT_NOT_FOUND')
    return found
  }
  if (projectId) {
    const latest = await runtime.store.latestDocument(projectId)
    if (!latest) throw new LookupError(`项目没有讲义：${projectId}`, 'DOCUMENT_NOT_FOUND')
    return latest
  }
  throw new LookupError('请提供 documentId 或 projectId', 'LOOKUP_ARGUMENT_MISSING')
}
