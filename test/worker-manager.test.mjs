import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { WorkerManager } from '../dist/services/worker-manager.js'

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'fake-worker')

test('WorkerManager performs handshake, status, and shutdown over JSON Lines', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-worker-manager-'))
  const config = normalizeConfig({
    dataDir,
    worker: { workerDir: fixtureDir, pythonPath: process.env.VIDORA_TEST_PYTHON || 'python3', startTimeoutMs: 10_000, requestTimeoutMs: 10_000, shutdownTimeoutMs: 5_000 },
    asr: { modelsDir: join(dataDir, 'models') },
  })
  const manager = new WorkerManager({
    config: config.worker,
    dataDir,
    modelsDir: config.asr.modelsDir,
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
  try {
    const init = await manager.ensureStarted()
    assert.equal(init.worker_version, 'fake')
    const status = await manager.getStatus()
    assert.equal(status.device, 'cpu')
    assert.equal(manager.isRunning(), true)
    await manager.shutdown()
    assert.equal(manager.isRunning(), false)
  } finally {
    await manager.shutdown().catch(() => {})
  }
})
