import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { DataStore } from '../dist/storage/data-store.js'
import { makeDocument, makeTranscript } from './fixtures.mjs'

test('persists transcript, source, document, and cache atomically', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-store-'))
  const config = normalizeConfig({ dataDir, asr: { modelsDir: join(dataDir, 'models') } })
  const store = new DataStore(config)
  await store.init()
  await store.initProject('prj-test')
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
  const loaded = await store.loadTranscript('prj-test', transcript.id)
  assert.equal(loaded.id, transcript.id)
  assert.equal(loaded.segments.length, 2)
  const latest = await store.latestTranscript('prj-test')
  assert.equal(latest.id, transcript.id)

  const document = makeDocument()
  await store.saveDocument(document, '# test\n')
  assert.equal((await store.loadDocument('prj-test', document.id)).title, '测试讲义')
  assert.equal(await readFile(store.notePath('prj-test', document.id), 'utf8'), '# test\n')

  await store.putCache({
    dedupe_key: 'key',
    project_id: 'prj-test',
    transcript_id: transcript.id,
    source_sha256: transcript.source.sha256,
    model: transcript.model,
    params_hash: 'hash',
    transcript_path: store.transcriptPath('prj-test', transcript.id),
    created_at: transcript.created_at,
    segment_count: 2,
    duration_ms: 10000,
  })
  assert.equal((await store.lookupCache('key'))?.transcript_id, transcript.id)
})

test('rejects id traversal', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-store-'))
  const store = new DataStore(normalizeConfig({ dataDir, asr: { modelsDir: join(dataDir, 'models') } }))
  await store.init()
  assert.throws(() => store.transcriptPath('../x', 'id'), /Invalid project id/)
  assert.throws(() => store.transcriptPath('prj', '../x'), /Invalid transcript id/)
})
