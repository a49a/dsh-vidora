import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { DataStore } from '../dist/storage/data-store.js'
import { WorkerManager } from '../dist/services/worker-manager.js'
import { TaskManager } from '../dist/services/task-manager.js'

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'fake-worker')

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-task-manager-'))
  const modelsDir = join(dataDir, 'models')
  await mkdir(join(modelsDir, 'Qwen3-ASR-0.6B'), { recursive: true })
  await mkdir(join(modelsDir, 'Qwen3-ForcedAligner-0.6B'), { recursive: true })
  const media = join(dataDir, 'lecture.mp3')
  await writeFile(media, 'fake media bytes')
  const config = normalizeConfig({
    dataDir,
    worker: { workerDir: fixtureDir, pythonPath: process.env.VIDORA_TEST_PYTHON || 'python3', startTimeoutMs: 10_000, requestTimeoutMs: 10_000, shutdownTimeoutMs: 5_000 },
    asr: { modelsDir, align: true },
    tasks: { progressPersistIntervalMs: 250, autoResume: false },
    llm: { mode: 'off' },
  })
  const store = new DataStore(config)
  await store.init()
  const worker = new WorkerManager({
    config: config.worker,
    dataDir,
    modelsDir,
    logPath: join(dataDir, 'logs', 'worker.log'),
    logMaxBytes: 1024 * 1024,
    recentLogLines: 20,
    device: 'cpu',
    dtype: 'float32',
    modelPaths: {},
    idleUnloadSeconds: 0,
    maxDurationMinutes: 60,
    maxFileSizeBytes: 1024 * 1024,
  })
  const tasks = new TaskManager(config, store, worker)
  await tasks.init()
  return { dataDir, media, store, tasks, worker, config }
}

async function waitFor(tasks, id, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = await tasks.getStatus(id)
    if (task && predicate(task)) return task
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timeout waiting for task ${id}`)
}

test('TaskManager completes a task, writes cache, and deduplicates a repeat request', async () => {
  const { media, store, tasks, worker, config } = await setup()
  try {
    const input = { media: { path: media, size: 17, extension: '.mp3' }, model: 'qwen3-asr-0.6b', align: true }
    const first = await tasks.create(input)
    const completed = await waitFor(tasks, first.task.id, task => task.status === 'completed')
    assert.equal(completed.stage, 'completed')
    assert.equal(completed.result.segment_count, 1)
    assert.equal((await store.lookupCache(completed.dedupe_key))?.transcript_id, completed.transcript_id)
    const second = await tasks.create(input)
    assert.equal(second.cached, true)
    assert.equal(second.transcript.id, completed.transcript_id)
  } finally {
    await tasks.dispose()
    await worker.shutdown().catch(() => {})
  }
})

test('TaskManager marks a crash as interrupted and can resume it', async () => {
  const { media, tasks, worker } = await setup()
  try {
    const first = await tasks.create({
      media: { path: media, size: 17, extension: '.mp3' },
      model: 'qwen3-asr-0.6b',
      align: true,
      context: 'crash',
    })
    const interrupted = await waitFor(tasks, first.task.id, task => task.status === 'interrupted')
    assert.equal(interrupted.resumable, true)
    assert.equal(interrupted.error.code, 'WORKER_EXITED')
    const resumed = await tasks.resumeTask(first.task.id)
    assert.ok(['queued', 'running'].includes(resumed.status))
    const completed = await waitFor(tasks, first.task.id, task => task.status === 'completed')
    assert.equal(completed.result.segment_count, 1)
  } finally {
    await tasks.dispose()
    await worker.shutdown().catch(() => {})
  }
})
