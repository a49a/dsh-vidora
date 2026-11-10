import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { VidoraRuntime } from '../dist/services/runtime.js'
import { createVidoraTools } from '../dist/tools/index.js'
import { apply } from '../dist/index.js'

test('registers the documented Vidora tool set', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-tools-'))
  const config = normalizeConfig({
    dataDir,
    asr: { modelsDir: join(dataDir, 'models') },
    privacy: { trustedLocalProviders: ['local'] },
  })
  const runtime = new VidoraRuntime(config)
  const tools = createVidoraTools(runtime)
  assert.deepEqual(
    tools.map(tool => tool.definition.name).sort(),
    [
      'vidora_cancel_task',
      'vidora_export',
      'vidora_generate_notes',
      'vidora_get_document',
      'vidora_get_transcript',
      'vidora_list_models',
      'vidora_task_status',
      'vidora_transcribe',
    ],
  )
  for (const tool of tools) {
    assert.equal(tool.definition.parameters.type, 'object')
    assert.equal(tool.definition.output.schema.type, 'object')
    assert.equal(typeof tool.definition.execute, 'function')
    const blocks = tool.definition.output.render({}, {})
    assert.ok(Array.isArray(blocks))
  }
  await runtime.dispose()
})

test('content-reading tools are conditionally hidden from untrusted sessions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-tools-'))
  const config = normalizeConfig({
    dataDir,
    asr: { modelsDir: join(dataDir, 'models') },
    privacy: { trustedLocalProviders: ['local'] },
  })
  const runtime = new VidoraRuntime(config)
  const tools = createVidoraTools(runtime)
  const getTranscript = tools.find(tool => tool.definition.name === 'vidora_get_transcript')
  const getDocument = tools.find(tool => tool.definition.name === 'vidora_get_document')
  assert.ok(getTranscript.options.when)
  assert.equal(await getTranscript.options.when({
    agent: {},
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash' },
    signal: new AbortController().signal,
  }), false)
  assert.equal(await getTranscript.options.when({
    agent: {},
    modelSelection: { provider: 'local', model: 'qwen' },
    signal: new AbortController().signal,
  }), true)
  assert.equal(await getDocument.options.when({
    agent: {},
    modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash' },
    signal: new AbortController().signal,
  }), false)
  await runtime.dispose()
})

test('Cordis apply registers tools through the plugin shape', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vidora-apply-'))
  const registered = []
  let cleanup = null
  let guard = null
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard(callback) {
        guard = callback
        return () => {}
      },
    },
    effect(callback) {
      const result = callback()
      assert.equal(typeof result, 'function')
      cleanup = result
      return () => {}
    },
    inject(_deps, callback) {
      callback({ llm: { stream: async function* () {}, listProviders: () => [] } })
      return () => {}
    },
    logger() {
      return { info() {}, warn() {}, error() {}, debug() {} }
    },
  }
  const config = normalizeConfig({
    dataDir,
    asr: { modelsDir: join(dataDir, 'models') },
    worker: { autoStart: false },
    llm: { mode: 'off' },
  })
  assert.equal(apply.length, 2)
  apply(ctx, config)
  assert.equal(registered.length, 8)
  assert.equal(typeof guard, 'function')
  await cleanup()
})
