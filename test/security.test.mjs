import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../dist/config.js'
import { resolveMediaFile, resolveOutputPath, AccessError } from '../dist/services/security.js'

test('accepts supported media and rejects unsupported extensions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vidora-security-'))
  const audio = join(directory, 'lecture.mp3')
  await writeFile(audio, 'not really mp3')
  const config = normalizeConfig({ dataDir: join(directory, '.data') })
  const resolved = await resolveMediaFile(audio, config.paths)
  assert.equal(resolved.path, await realpath(audio))
  const text = join(directory, 'notes.txt')
  await writeFile(text, 'hello')
  await assert.rejects(() => resolveMediaFile(text, config.paths), AccessError)
})

test('enforces configured roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vidora-security-'))
  const allowed = join(directory, 'allowed')
  const outside = join(directory, 'outside')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(allowed)
  await mkdir(outside)
  const audio = join(outside, 'lecture.wav')
  await writeFile(audio, 'RIFF')
  const config = normalizeConfig({
    dataDir: join(directory, '.data'),
    paths: { mode: 'roots', allowedRoots: [allowed] },
  })
  await assert.rejects(() => resolveMediaFile(audio, config.paths), /allowedRoots/)
})

test('blocks system directories and resolves output paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vidora-security-'))
  const config = normalizeConfig({ dataDir: join(directory, '.data') })
  await assert.rejects(() => resolveOutputPath('/etc/vidora-test.md', config.paths, config.dataDir), /受保护/)
  const output = await resolveOutputPath(join(directory, 'out.md'), config.paths, config.dataDir)
  assert.equal(output, join(directory, 'out.md'))
})
