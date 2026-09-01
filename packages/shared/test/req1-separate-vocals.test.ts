import { describe, expect, it } from 'vitest'
import { req1UsesSeparateVocals } from '../src/index.js'

describe('req1UsesSeparateVocals', () => {
  it('is true only when req1 and separateVocals is explicitly true', () => {
    expect(req1UsesSeparateVocals({ kind: 'req1', separateVocals: true })).toBe(true)
    expect(req1UsesSeparateVocals({ kind: 'req1', separateVocals: false })).toBe(false)
    expect(req1UsesSeparateVocals({ kind: 'req1' })).toBe(false)
    expect(req1UsesSeparateVocals({ kind: 'vocal-separation', separateVocals: true })).toBe(false)
  })
})
