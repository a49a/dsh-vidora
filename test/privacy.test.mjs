import assert from 'node:assert/strict'
import test from 'node:test'
import { PrivacyPolicy, PrivacyError } from '../dist/services/privacy.js'

const strict = new PrivacyPolicy({
  strictLocal: true,
  trustedLocalProviders: ['local-ollama'],
  trustedLocalModels: ['qwen2.5:7b'],
  untrustedFileToolPolicy: 'block-data-path',
}, '/Users/me/Library/Application Support/Vidora')

test('trusts only configured local provider and model', () => {
  assert.equal(strict.isTrusted({ provider: 'local-ollama', model: 'qwen2.5:7b' }), true)
  assert.equal(strict.isTrusted({ provider: 'local-ollama', model: 'other' }), false)
  assert.equal(strict.isTrusted({ provider: 'deepseek-account', model: 'deepseek-flash' }), false)
  assert.equal(strict.isTrusted(undefined), false)
})

test('blocks content reads for a remote session', () => {
  const agent = { model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } }
  assert.throws(() => strict.assertContentReadAllowed(agent), PrivacyError)
  const local = { model: { current: () => ({ provider: 'local-ollama', model: 'qwen2.5:7b' }) } }
  assert.doesNotThrow(() => strict.assertContentReadAllowed(local))
})

test('strictLocal=false disables the policy gate', () => {
  const open = new PrivacyPolicy({ strictLocal: false, trustedLocalProviders: [], trustedLocalModels: [], untrustedFileToolPolicy: 'block-all' })
  assert.equal(open.isTrusted({ provider: 'remote', model: 'x' }), true)
  assert.doesNotThrow(() => open.assertContentReadAllowed(undefined))
  assert.equal(open.guardToolCall('bash', { command: 'cat transcript.json' }, undefined), undefined)
})

test('guards file tools that reference Vidora data paths', () => {
  const remote = { model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } }
  const local = { model: { current: () => ({ provider: 'local-ollama', model: 'qwen2.5:7b' }) } }
  assert.match(
    strict.guardToolCall('bash', { command: 'cat "/Users/me/Library/Application Support/Vidora/projects/prj-1/transcript.json"' }, remote),
    /strict-local/,
  )
  assert.equal(strict.guardToolCall('read', { path: '/tmp/note.md' }, remote), undefined)
  assert.equal(strict.guardToolCall('bash', { command: 'ls testdata/audio' }, remote), undefined)
  assert.equal(strict.guardToolCall('vidora_export', { format: 'md' }, remote), undefined)
  assert.equal(strict.guardToolCall('bash', { command: 'cat transcript.json' }, local), undefined)
  strict.addSensitivePath('/Users/me/Videos/private-lecture.mp4')
  assert.match(strict.guardToolCall('bash', { command: 'cat /Users/me/Videos/private-lecture.mp4' }, remote), /strict-local/)
  const blockAll = new PrivacyPolicy({
    strictLocal: true,
    trustedLocalProviders: [],
    trustedLocalModels: [],
    untrustedFileToolPolicy: 'block-all',
  })
  assert.match(blockAll.guardToolCall('read', { path: '/tmp/note.md' }, remote), /disabled/)
})
