import type { Transcript } from './types.js'
import { formatSrtTimestamp } from './time.js'

export function renderSrt(transcript: Transcript): string {
  const blocks: string[] = []
  let index = 1
  for (const segment of transcript.segments) {
    const text = segment.text.replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    blocks.push(
      `${index}\n${formatSrtTimestamp(segment.start_ms)} --> ${formatSrtTimestamp(segment.end_ms)}\n${text}`,
    )
    index += 1
  }
  return `${blocks.join('\n\n')}\n`
}
