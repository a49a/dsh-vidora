import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSrt } from '../dist/core/srt.js'
import { formatClock, formatSrtTimestamp } from '../dist/core/time.js'
import { makeTranscript } from './fixtures.mjs'

test('formats clocks and SRT timestamps', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(61_000), '01:01')
  assert.equal(formatClock(3_661_000), '1:01:01')
  assert.equal(formatSrtTimestamp(3_661_123), '01:01:01,123')
})

test('renders SRT from stable transcript segments', () => {
  const transcript = makeTranscript()
  const srt = renderSrt(transcript)
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,000\n第一段。/)
  assert.match(srt, /\n2\n00:00:04,000 --> 00:00:06,500\nSecond segment\./)
})
