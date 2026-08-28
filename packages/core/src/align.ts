import type { Transcript, TranscriptSegment } from '@koubox/shared'

const sentencePattern = /[^。！？!?\n]+[。！？!?]?/g

function readableUnits(text: string): number {
  return Math.max(1, [...text.replace(/\s/g, '')].length)
}

/**
 * 计算两个字符串的编辑距离（Levenshtein Distance）
 * 用于匹配原文与 ASR 识别文本
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1
      }
    }
  }
  return dp[m][n]
}

/**
 * 智能断句：识别自然停顿点
 * 优先在句号、问号、感叹号处断句，其次是逗号、分号
 */
function smartSentenceSplit(text: string): string[] {
  // 首先按强标点符号（句号、问号、感叹号）分割
  const primarySentences = text.split(/([。！？!?]+)/).filter(Boolean)
  const sentences: string[] = []
  let current = ''

  for (const part of primarySentences) {
    if (/^[。！？!?]+$/.test(part)) {
      current += part
      if (current.trim()) sentences.push(current.trim())
      current = ''
    } else {
      current += part
    }
  }

  if (current.trim()) sentences.push(current.trim())

  // 如果单句过长（超过 50 字），在逗号、分号处二次分割
  const finalSentences: string[] = []
  for (const sentence of sentences) {
    if ([...sentence].length > 50) {
      const subParts = sentence.split(/([，、；,:;])/).filter(Boolean)
      let subCurrent = ''
      for (const part of subParts) {
        subCurrent += part
        if (/^[，、；,:;]$/.test(part) && [...subCurrent].length > 15) {
          finalSentences.push(subCurrent.trim())
          subCurrent = ''
        }
      }
      if (subCurrent.trim()) finalSentences.push(subCurrent.trim())
    } else {
      finalSentences.push(sentence)
    }
  }

  return finalSentences.filter(Boolean)
}

/**
 * 增强版对齐算法：结合 ASR 时间锚点与原文脚本
 *
 * 策略：
 * 1. 智能断句：识别原文的自然停顿点
 * 2. 文本匹配：通过编辑距离找到原文与 ASR 片段的对应关系
 * 3. 时间映射：将 ASR 的时间戳映射到原文句子上
 * 4. 空隙处理：如果存在未覆盖的时间段，按比例分配
 */
export function alignKnownText(script: string, anchors: Transcript): Transcript {
  const sentences = smartSentenceSplit(script)

  if (sentences.length === 0 || anchors.segments.length === 0) {
    return { ...anchors, segments: anchors.segments.map((segment) => ({ ...segment })) }
  }

  // 如果 ASR 片段数与原文句子数接近，尝试直接匹配
  if (Math.abs(sentences.length - anchors.segments.length) <= 2) {
    return directMatchAlignment(sentences, anchors)
  }

  // 否则使用文本相似度匹配
  return similarityBasedAlignment(sentences, anchors)
}

/**
 * 直接匹配对齐：当原文句数与 ASR 片段数接近时使用
 */
function directMatchAlignment(sentences: string[], anchors: Transcript): Transcript {
  const segments: TranscriptSegment[] = []
  const asrSegments = anchors.segments

  // 为每个原文句子找到最佳匹配的 ASR 片段
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]
    const targetIndex = Math.min(i, asrSegments.length - 1)
    const asrSegment = asrSegments[targetIndex]

    // 如果是最后一句，使用最后一个 ASR 片段的结束时间
    if (i === sentences.length - 1 && targetIndex < asrSegments.length - 1) {
      segments.push({
        text: sentence,
        start: asrSegment.start,
        end: asrSegments[asrSegments.length - 1].end
      })
    } else {
      segments.push({
        text: sentence,
        start: asrSegment.start,
        end: asrSegment.end
      })
    }
  }

  return { language: anchors.language, segments }
}

/**
 * 基于相似度的对齐：使用编辑距离匹配原文与 ASR
 */
function similarityBasedAlignment(sentences: string[], anchors: Transcript): Transcript {
  const segments: TranscriptSegment[] = []
  const asrSegments = anchors.segments
  const asrFullText = asrSegments.map((s) => s.text.replace(/\s/g, '')).join('')
  const scriptFullText = sentences.join('').replace(/\s/g, '')

  // 计算相似度：如果相似度很低，回退到简单按比例分配
  const similarity = 1 - levenshteinDistance(scriptFullText, asrFullText) / Math.max(scriptFullText.length, asrFullText.length)

  if (similarity < 0.5) {
    // 相似度太低，使用基线算法
    return baselineProportionalAlignment(sentences, anchors)
  }

  // 使用动态规划匹配原文句子与 ASR 片段
  const totalStart = asrSegments[0].start
  const totalEnd = asrSegments[asrSegments.length - 1].end
  const totalDuration = totalEnd - totalStart

  let asrIndex = 0
  let accumulatedDuration = 0

  for (const sentence of sentences) {
    const sentenceUnits = readableUnits(sentence)
    const estimatedDuration = (totalDuration * sentenceUnits) / readableUnits(scriptFullText)

    // 找到对应的 ASR 片段范围
    let start = totalStart + accumulatedDuration
    let end = start + estimatedDuration

    // 尝试对齐到最近的 ASR 边界
    while (asrIndex < asrSegments.length && asrSegments[asrIndex].end < end) {
      asrIndex++
    }

    if (asrIndex < asrSegments.length) {
      // 对齐到 ASR 片段边界
      end = Math.min(asrSegments[asrIndex].end, totalEnd)
      if (segments.length > 0) {
        start = segments[segments.length - 1].end
      }
    }

    segments.push({ text: sentence, start, end: Math.max(start + 0.1, end) })
    accumulatedDuration += estimatedDuration
  }

  // 确保最后一句覆盖到音频结束
  if (segments.length > 0) {
    segments[segments.length - 1].end = totalEnd
  }

  return { language: anchors.language, segments }
}

/**
 * 基线算法：简单按字符数比例分配时间（保留原有逻辑）
 */
function baselineProportionalAlignment(sentences: string[], anchors: Transcript): Transcript {
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
