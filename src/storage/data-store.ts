import { basename, join } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import type {
  CacheEntry,
  CacheIndex,
  ProjectSummary,
  SourceRecord,
  Transcript,
  VidoraDocument,
  VidoraTask,
} from '../core/types.js'
import { parseDocument, parseTranscript } from '../core/transcript.js'
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  pathExists,
  readJsonFile,
  safeFileBaseName,
} from '../core/fs.js'
import { nowIso } from '../core/time.js'
import type { VidoraConfig } from '../config.js'

const DATA_SCHEMA_VERSION = 1
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export class DataStore {
  readonly root: string
  readonly projectsDir: string
  readonly tasksDir: string
  readonly cacheDir: string
  readonly logsDir: string
  readonly tmpDir: string
  readonly modelsDir: string
  private cacheCounter = 0
  private cacheWrite: Promise<void> = Promise.resolve()

  constructor(config: VidoraConfig) {
    this.root = config.dataDir
    this.projectsDir = join(this.root, 'projects')
    this.tasksDir = join(this.root, 'tasks')
    this.cacheDir = join(this.root, 'cache')
    this.logsDir = join(this.root, 'logs')
    this.tmpDir = join(this.root, 'tmp')
    this.modelsDir = config.asr.modelsDir
  }

  async init(): Promise<void> {
    for (const directory of [
      this.root,
      this.projectsDir,
      this.tasksDir,
      this.cacheDir,
      this.logsDir,
      this.tmpDir,
      this.modelsDir,
    ]) {
      await ensureDir(directory)
    }
    const metaPath = join(this.root, 'meta.json')
    if (!(await pathExists(metaPath))) {
      await atomicWriteJson(metaPath, {
        schema_version: DATA_SCHEMA_VERSION,
        application: 'Vidora',
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      return
    }
    const meta = await readJsonFile(metaPath, 1024 * 1024) as Record<string, unknown>
    if (meta.schema_version !== DATA_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported Vidora data schema version ${String(meta.schema_version)} at ${this.root}`,
      )
    }
  }

  projectDir(projectId: string): string {
    assertId(projectId, 'project id')
    return join(this.projectsDir, projectId)
  }

  transcriptsDir(projectId: string): string {
    return join(this.projectDir(projectId), 'transcripts')
  }

  documentsDir(projectId: string): string {
    return join(this.projectDir(projectId), 'documents')
  }

  notesDir(projectId: string): string {
    return join(this.projectDir(projectId), 'notes')
  }

  exportsDir(projectId: string): string {
    return join(this.projectDir(projectId), 'exports')
  }

  taskDir(taskId: string): string {
    assertId(taskId, 'task id')
    return join(this.tasksDir, taskId)
  }

  transcriptPath(projectId: string, transcriptId: string): string {
    assertId(transcriptId, 'transcript id')
    return join(this.transcriptsDir(projectId), `${transcriptId}.json`)
  }

  documentPath(projectId: string, documentId: string): string {
    assertId(documentId, 'document id')
    return join(this.documentsDir(projectId), `${documentId}.json`)
  }

  notePath(projectId: string, documentId: string): string {
    assertId(documentId, 'document id')
    return join(this.notesDir(projectId), `${documentId}.md`)
  }

  async initProject(projectId: string): Promise<void> {
    await ensureDir(this.transcriptsDir(projectId))
    await ensureDir(this.documentsDir(projectId))
    await ensureDir(this.notesDir(projectId))
    await ensureDir(this.exportsDir(projectId))
  }

  async initTask(taskId: string): Promise<void> {
    await ensureDir(this.taskDir(taskId))
    await ensureDir(join(this.taskDir(taskId), 'work'))
  }

  async saveSource(source: SourceRecord): Promise<void> {
    await this.initProject(source.project_id)
    await atomicWriteJson(join(this.projectDir(source.project_id), 'source.json'), source)
  }

  async loadSource(projectId: string): Promise<SourceRecord | undefined> {
    const path = join(this.projectDir(projectId), 'source.json')
    if (!(await pathExists(path))) return undefined
    return await readJsonFile(path, 16 * 1024 * 1024) as SourceRecord
  }

  async touchSource(
    projectId: string,
    mutate: (source: SourceRecord) => SourceRecord,
  ): Promise<SourceRecord | undefined> {
    const existing = await this.loadSource(projectId)
    if (!existing) return undefined
    const next = mutate({ ...existing, updated_at: nowIso() })
    await this.saveSource(next)
    return next
  }

  async saveTranscript(transcript: Transcript, copyLatest = true): Promise<void> {
    await this.initProject(transcript.project_id)
    const target = this.transcriptPath(transcript.project_id, transcript.id)
    await atomicWriteJson(target, transcript)
    if (copyLatest) {
      await atomicWriteFile(
        join(this.projectDir(transcript.project_id), 'transcript.json'),
        `${JSON.stringify(transcript, null, 2)}\n`,
      )
    }
    await this.touchSource(transcript.project_id, source => ({
      ...source,
      duration_ms: transcript.source.duration_ms,
      container: transcript.source.container ?? source.container,
      audio_codec: transcript.source.audio_codec ?? source.audio_codec,
      sample_rate: transcript.source.sample_rate ?? source.sample_rate,
      channels: transcript.source.channels ?? source.channels,
      transcript_ids: unique([...source.transcript_ids, transcript.id]),
    }))
  }

  async loadTranscript(projectId: string, transcriptId: string): Promise<Transcript> {
    const value = await readJsonFile(this.transcriptPath(projectId, transcriptId))
    return parseTranscript(value)
  }

  async latestTranscript(projectId: string): Promise<Transcript | undefined> {
    const path = join(this.projectDir(projectId), 'transcript.json')
    if (!(await pathExists(path))) return undefined
    return parseTranscript(await readJsonFile(path))
  }

  async findTranscriptById(transcriptId: string): Promise<Transcript | undefined> {
    assertId(transcriptId, 'transcript id')
    if (!(await pathExists(this.projectsDir))) return undefined
    const names = await readdir(this.projectsDir)
    for (const name of names) {
      const path = join(this.projectsDir, name, 'transcripts', `${transcriptId}.json`)
      if (!(await pathExists(path))) continue
      try {
        return parseTranscript(await readJsonFile(path))
      } catch {
        return undefined
      }
    }
    return undefined
  }

  async findDocumentById(documentId: string): Promise<VidoraDocument | undefined> {
    assertId(documentId, 'document id')
    if (!(await pathExists(this.projectsDir))) return undefined
    const names = await readdir(this.projectsDir)
    for (const name of names) {
      const path = join(this.projectsDir, name, 'documents', `${documentId}.json`)
      if (!(await pathExists(path))) continue
      try {
        return parseDocument(await readJsonFile(path))
      } catch {
        return undefined
      }
    }
    return undefined
  }

  async listTranscripts(projectId: string): Promise<Transcript[]> {
    const directory = this.transcriptsDir(projectId)
    if (!(await pathExists(directory))) return []
    const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
    const results: Transcript[] = []
    for (const name of names) {
      try {
        results.push(parseTranscript(await readJsonFile(join(directory, name))))
      } catch {
        // A corrupt transcript is reported by project inspection, not fatal to listing.
      }
    }
    return results
  }

  async saveDocument(document: VidoraDocument, markdown: string): Promise<void> {
    await this.initProject(document.project_id)
    await atomicWriteJson(this.documentPath(document.project_id, document.id), document)
    await atomicWriteFile(this.notePath(document.project_id, document.id), markdown)
    await atomicWriteFile(join(this.projectDir(document.project_id), 'notes.md'), markdown)
    await atomicWriteFile(
      join(this.projectDir(document.project_id), 'document.json'),
      `${JSON.stringify(document, null, 2)}\n`,
    )
    await this.touchSource(document.project_id, source => ({
      ...source,
      document_ids: unique([...source.document_ids, document.id]),
    }))
  }

  async loadDocument(projectId: string, documentId: string): Promise<VidoraDocument> {
    return parseDocument(await readJsonFile(this.documentPath(projectId, documentId)))
  }

  async latestDocument(projectId: string): Promise<VidoraDocument | undefined> {
    const path = join(this.projectDir(projectId), 'document.json')
    if (!(await pathExists(path))) return undefined
    return parseDocument(await readJsonFile(path))
  }

  async listDocuments(projectId: string): Promise<VidoraDocument[]> {
    const directory = this.documentsDir(projectId)
    if (!(await pathExists(directory))) return []
    const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
    const results: VidoraDocument[] = []
    for (const name of names) {
      try {
        results.push(parseDocument(await readJsonFile(join(directory, name))))
      } catch {
        // Skip corrupt documents in list views.
      }
    }
    return results
  }

  async saveTask(task: VidoraTask): Promise<void> {
    await this.initTask(task.id)
    await atomicWriteJson(join(this.taskDir(task.id), 'task.json'), task)
  }

  async loadTask(taskId: string): Promise<VidoraTask | undefined> {
    const path = join(this.taskDir(taskId), 'task.json')
    if (!(await pathExists(path))) return undefined
    return await readJsonFile(path, 16 * 1024 * 1024) as VidoraTask
  }

  async listTasks(): Promise<VidoraTask[]> {
    if (!(await pathExists(this.tasksDir))) return []
    const names = await readdir(this.tasksDir)
    const tasks: VidoraTask[] = []
    for (const name of names) {
      try {
        const task = await this.loadTask(name)
        if (task) tasks.push(task)
      } catch {
        // Ignore malformed task records; they remain on disk for diagnosis.
      }
    }
    return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  async findTaskByDedupe(dedupeKey: string): Promise<VidoraTask | undefined> {
    const tasks = await this.listTasks()
    return tasks
      .filter(task => task.dedupe_key === dedupeKey)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
  }

  async projectSummary(projectId: string): Promise<ProjectSummary | undefined> {
    const source = await this.loadSource(projectId)
    if (!source) return undefined
    const transcripts = await this.listTranscripts(projectId)
    const documents = await this.listDocuments(projectId)
    return {
      project_id: projectId,
      source,
      transcripts: transcripts.map(transcript => ({
        id: transcript.id,
        created_at: transcript.created_at,
        model: transcript.model,
        language: transcript.language,
        stats: transcript.stats,
      })),
      documents: documents.map(document => ({
        id: document.id,
        created_at: document.created_at,
        mode: document.mode,
        title: document.title,
        version_number: document.version_number,
      })),
    }
  }

  async recentProjects(limit = 20): Promise<ProjectSummary[]> {
    if (!(await pathExists(this.projectsDir))) return []
    const names = await readdir(this.projectsDir)
    const summaries: ProjectSummary[] = []
    for (const name of names) {
      try {
        const summary = await this.projectSummary(name)
        if (summary) summaries.push(summary)
      } catch {
        // Ignore unreadable projects in recent listings.
      }
    }
    return summaries
      .sort((a, b) => b.source.updated_at.localeCompare(a.source.updated_at))
      .slice(0, limit)
  }

  async lookupCache(dedupeKey: string): Promise<CacheEntry | undefined> {
    const index = await this.loadCache()
    return index.entries[dedupeKey]
  }

  async putCache(entry: CacheEntry): Promise<void> {
    const run = async () => {
      const index = await this.loadCache()
      index.entries[entry.dedupe_key] = entry
      await atomicWriteJson(join(this.cacheDir, 'index.json'), index)
    }
    this.cacheWrite = this.cacheWrite.then(run, run)
    await this.cacheWrite
  }

  async removeCache(dedupeKey: string): Promise<void> {
    const run = async () => {
      const index = await this.loadCache()
      if (!(dedupeKey in index.entries)) return
      delete index.entries[dedupeKey]
      await atomicWriteJson(join(this.cacheDir, 'index.json'), index)
    }
    this.cacheWrite = this.cacheWrite.then(run, run)
    await this.cacheWrite
  }

  async loadCache(): Promise<CacheIndex> {
    const path = join(this.cacheDir, 'index.json')
    if (!(await pathExists(path))) return { version: 1, entries: {} }
    const value = await readJsonFile(path, 64 * 1024 * 1024) as CacheIndex
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') {
      throw new Error(`Invalid Vidora cache index at ${path}`)
    }
    return value
  }

  async cacheSize(): Promise<number> {
    try {
      const info = await stat(join(this.cacheDir, 'index.json'))
      return info.size
    } catch {
      return 0
    }
  }

  exportPath(projectId: string, sourcePath: string, suffix: string, format: string): string {
    const base = safeFileBaseName(sourcePath)
    return join(this.exportsDir(projectId), `${base}${suffix}.${format}`)
  }

  async cleanup(options: { olderThanDays: number; dryRun: boolean }): Promise<{
    removedTasks: string[]
    removedCacheEntries: string[]
    removedTaskDirs: string[]
  }> {
    const removedTasks: string[] = []
    const removedCacheEntries: string[] = []
    const removedTaskDirs: string[] = []
    const cutoff = Date.now() - options.olderThanDays * 86_400_000
    const tasks = await this.listTasks()
    for (const task of tasks) {
      const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
      const updated = Date.parse(task.updated_at)
      if (!terminal || !Number.isFinite(updated) || updated >= cutoff) continue
      removedTasks.push(task.id)
      if (!options.dryRun) {
        await rm(join(this.taskDir(task.id), 'work'), { recursive: true, force: true }).catch(() => {})
        await rm(join(this.taskDir(task.id), 'checkpoint.json'), { force: true }).catch(() => {})
        removedTaskDirs.push(task.id)
      }
    }

    const cache = await this.loadCache()
    for (const [key, entry] of Object.entries(cache.entries)) {
      if (!(await pathExists(entry.transcript_path))) {
        removedCacheEntries.push(key)
        if (!options.dryRun) delete cache.entries[key]
      }
    }
    if (!options.dryRun && removedCacheEntries.length > 0) {
      await atomicWriteJson(join(this.cacheDir, 'index.json'), cache)
    }
    return { removedTasks, removedCacheEntries, removedTaskDirs }
  }

  async taskWorkDir(taskId: string): Promise<string> {
    const dir = join(this.taskDir(taskId), 'work')
    await ensureDir(dir)
    return dir
  }

  async cacheCounterNext(): Promise<number> {
    this.cacheCounter += 1
    return this.cacheCounter
  }

  exportNameFor(document: VidoraDocument, sourcePath: string): string {
    return `${safeFileBaseName(sourcePath)}-${document.mode}-v${document.version_number}`
  }

  projectDisplayName(projectId: string): string {
    return basename(this.projectDir(projectId))
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function assertId(value: string, what: string): void {
  if (!ID_RE.test(value)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`)
  }
}
