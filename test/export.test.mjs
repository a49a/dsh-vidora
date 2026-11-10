import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { DataStore } from '../dist/storage/data-store.js'
import { DocumentService } from '../dist/services/document-service.js'
import { makeDocument, makeTranscript } from './fixtures.mjs'

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-export-'))
  const config = normalizeConfig({ dataDir, asr: { modelsDir: join(dataDir, 'models') } })
  const store = new DataStore(config)
  await store.init()
  const transcript = makeTranscript()
  await store.saveSource({
    project_id: 'prj-test',
    path: transcript.source.path,
    sha256: transcript.source.sha256,
    size_bytes: transcript.source.size_bytes,
    duration_ms: transcript.source.duration_ms,
    container: transcript.source.container,
    audio_codec: transcript.source.audio_codec,
    sample_rate: transcript.source.sample_rate,
    channels: transcript.source.channels,
    created_at: transcript.created_at,
    updated_at: transcript.created_at,
    transcript_ids: [],
    document_ids: [],
  })
  await store.saveTranscript(transcript)
  const document = makeDocument()
  await store.saveDocument(document, '# 测试讲义\n')
  const service = new DocumentService(config, store, null)
  return { config, store, transcript, document, service }
}

test('exports transcript and document in all supported formats', async () => {
  const { service, transcript, document } = await setup()
  const md = await service.export({ format: 'md', document, transcript })
  assert.match(await readFile(md.path, 'utf8'), /# 测试讲义/)
  assert.equal(md.kind, 'document')

  const json = await service.export({ format: 'json', transcript })
  const parsed = JSON.parse(await readFile(json.path, 'utf8'))
  assert.equal(parsed.id, transcript.id)

  const txt = await service.export({ format: 'txt', transcript })
  assert.match(await readFile(txt.path, 'utf8'), /\[00:01\] 第一段/)

  const srt = await service.export({ format: 'srt', transcript })
  assert.match(await readFile(srt.path, 'utf8'), /00:00:01,000 --> 00:00:03,000/)
})

test('refuses to overwrite by default and allows an explicit overwrite', async () => {
  const { service, transcript } = await setup()
  const first = await service.export({ format: 'txt', transcript })
  await assert.rejects(
    () => service.export({ format: 'txt', transcript }),
    /已存在/,
  )
  const second = await service.export({ format: 'txt', transcript, overwrite: true })
  assert.equal(second.path, first.path)
})
