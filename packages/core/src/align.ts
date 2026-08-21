import type { Transcript, TranscriptSegment } from '@koubox/shared'

const sentencePattern = /[^。！？!?\n]+[。！？!?]?/g

function readableUnits(text: string): number {
  return Math.max(1, [...text.replace(/\s/g, '')].length)
}

/**
 * Baseline alignment for known scripts. It deliberately preserves the supplied
 * copy and uses the ASR timeline only as timing anchors. A later local forced-
 * alignment runner can replace this implementation without changing the
 * Transcript contract.
 */
export function alignKnownText(script: string, anchors: Transcript): Transcript {
  const sentences = (script.match(sentencePattern) ?? [])
    .map((item) => item.trim())
    .filter(Boolean)

  if (sentences.length === 0 || anchors.segments.length === 0) {
    return { ...anchors, segments: anchors.segments.map((segment) => ({ ...segment })) }
  }

  const start = anchors.segments[0].start
  const end = anchors.segments.at(-1)?.end ?? start
  const duration = Math.max(0, end - start)
  const totalUnits = sentences.reduce((sum, sentence) => sum + readableUnits(sentence), 0)
  let cursor = start

  const segments: TranscriptSegment[] = sentences.map((text, index) => {
    const isLast = index === sentences.length - 1
    const allocated = isLast ? end - cursor : (duration * readableUnits(text)) / totalUnits
    const segment = { text, start: cursor, end: Math.max(cursor, cursor + allocated) }
    cursor = segment.end
    return segment
  })

  return { language: anchors.language, segments }
}
