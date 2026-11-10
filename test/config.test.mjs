import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import test from 'node:test'
import { normalizeConfig, Config, defaultDataDir } from '../dist/config.js'

test('normalizes defaults and keeps strict local mode on', () => {
  const config = normalizeConfig({ dataDir: '/tmp/vidora-test' })
  assert.equal(config.dataDir, '/tmp/vidora-test')
  assert.equal(config.asr.defaultModel, 'qwen3-asr-0.6b')
  assert.equal(config.asr.align, true)
  assert.equal(config.asr.vad.thresholdDb, null)
  assert.equal(config.privacy.strictLocal, true)
  assert.equal(config.privacy.untrustedFileToolPolicy, 'block-data-path')
  assert.equal(config.llm.mode, 'off')
  assert.equal(config.worker.idleUnloadSeconds, 900)
  assert.equal(config.paths.mode, 'explicit')
})

test('default data dir follows the operating system convention', () => {
  const directory = defaultDataDir()
  assert.ok(directory.includes('Vidora') || directory.includes('vidora'))
  if (process.platform === 'darwin') assert.ok(directory.startsWith(homedir()))
})

test('supports the standard-schema config interface', () => {
  const result = Config['~standard'].validate({ dataDir: '/tmp/vidora-test', asr: { device: 'mps' } })
  assert.ok(!('issues' in result))
  assert.equal(result.value.asr.device, 'mps')
})

test('rejects invalid config', () => {
  const result = Config['~standard'].validate({ asr: { device: 'tpu' } })
  assert.ok('issues' in result)
  assert.match(result.issues[0].message, /asr.device/)
})

test('requires explicit trust before Harness LLM reuse', () => {
  assert.throws(() => normalizeConfig({
    dataDir: '/tmp/vidora-test',
    llm: { mode: 'harness', harnessProvider: 'local', harnessModel: 'qwen' },
  }), /trustedLocalProviders/)
  const config = normalizeConfig({
    dataDir: '/tmp/vidora-test',
    llm: { mode: 'harness', harnessProvider: 'local', harnessModel: 'qwen' },
    privacy: { trustedLocalProviders: ['local'] },
  })
  assert.equal(config.llm.mode, 'harness')
})

test('roots mode requires a root', () => {
  assert.throws(() => normalizeConfig({
    dataDir: '/tmp/vidora-test',
    paths: { mode: 'roots' },
  }), /allowedRoots/)
})
