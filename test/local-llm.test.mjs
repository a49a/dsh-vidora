import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import {
  assertLocalEndpoint,
  createLocalLlmClient,
  LocalLlmError,
  parseJsonObject,
} from '../dist/services/local-llm.js'

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        port: address.port,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

test('rejects non-loopback endpoints unless explicitly allowed', async () => {
  await assert.rejects(
    () => assertLocalEndpoint('http://192.0.2.10:11434', false),
    LocalLlmError,
  )
  assert.equal(await assertLocalEndpoint('http://127.0.0.1:11434', false), true)
  assert.equal(await assertLocalEndpoint('http://192.0.2.10:11434', true), false)
})

test('parses fenced JSON and rejects non-JSON', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonObject('prefix {"a":2} suffix'), { a: 2 })
  assert.throws(() => parseJsonObject('not json'), LocalLlmError)
})

test('talks to a loopback Ollama-compatible endpoint', async () => {
  const endpoint = await listen((request, response) => {
    if (request.url === '/api/tags') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }))
      return
    }
    if (request.url === '/api/chat') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        assert.equal(parsed.format, 'json')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ message: { content: '{"sections":[]}' } }))
      })
      return
    }
    response.statusCode = 404
    response.end('no')
  })
  try {
    const config = normalizeConfig({
      dataDir: '/tmp/vidora-local-llm',
      llm: { mode: 'ollama', model: 'qwen2.5:7b', baseUrl: `http://127.0.0.1:${endpoint.port}` },
    })
    const client = createLocalLlmClient(config.llm, config.privacy)
    assert.ok(client)
    const health = await client.health()
    assert.equal(health.reachable, true)
    assert.deepEqual(health.models, ['qwen2.5:7b'])
    const value = await client.completeJson({ system: 'system', prompt: 'prompt' })
    assert.deepEqual(value, { sections: [] })
  } finally {
    await endpoint.close()
  }
})

test('reuses a trusted Harness provider without a network call', async () => {
  const config = normalizeConfig({
    dataDir: '/tmp/vidora-local-llm',
    llm: { mode: 'harness', harnessProvider: 'local-provider', harnessModel: 'qwen-local' },
    privacy: { trustedLocalProviders: ['local-provider'], trustedLocalModels: ['qwen-local'] },
  })
  const harness = {
    listProviders: () => [{ id: 'local-provider', name: 'Local' }],
    async *stream() {
      yield { type: 'text-delta', text: '{"sections":' }
      yield { type: 'text-delta', text: '[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const client = createLocalLlmClient(config.llm, config.privacy, harness)
  assert.ok(client)
  assert.deepEqual(await client.completeJson({ system: 's', prompt: 'p' }), { sections: [] })
  assert.equal(client.info.local, true)
  const untrustedClient = createLocalLlmClient(config.llm, {
    ...config.privacy,
    trustedLocalProviders: [],
  }, harness)
  await assert.rejects(
    () => untrustedClient.completeJson({ system: 's', prompt: 'p' }),
    /trustedLocalProviders/,
  )
})

test('talks to a loopback OpenAI-compatible endpoint', async () => {
  const endpoint = await listen((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'qwen2.5-1.5b' }] }))
      return
    }
    if (request.url === '/v1/chat/completions') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        assert.equal(parsed.response_format.type, 'json_object')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: '{"sections":[]}' } }] }))
      })
      return
    }
    response.statusCode = 404
    response.end('no')
  })
  try {
    const config = normalizeConfig({
      dataDir: '/tmp/vidora-local-llm',
      llm: { mode: 'openai', model: 'qwen2.5-1.5b', baseUrl: `http://127.0.0.1:${endpoint.port}/v1` },
    })
    const client = createLocalLlmClient(config.llm, config.privacy)
    assert.ok(client)
    assert.equal((await client.health()).reachable, true)
    assert.deepEqual(await client.completeJson({ system: 'system', prompt: 'prompt' }), { sections: [] })
  } finally {
    await endpoint.close()
  }
})
