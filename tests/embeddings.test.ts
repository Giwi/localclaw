import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '../src/embeddings.js'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('returns 0 when both vectors are zero', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0)
  })

  it('returns 0 when first vector is zero', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
  })

  it('returns 0 when second vector is zero', () => {
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0)
  })

  it('handles single-element vectors', () => {
    expect(cosineSimilarity([5], [5])).toBeCloseTo(1)
    expect(cosineSimilarity([5], [-5])).toBeCloseTo(-1)
  })

  it('returns NaN for vectors of different lengths', () => {
    const result = cosineSimilarity([1, 2, 3], [1, 2])
    expect(result).toBeNaN()
  })

  it('returns 0 for empty arrays (denominator is zero)', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('is commutative', () => {
    const a = [0.5, -0.3, 0.8]
    const b = [0.2, 0.9, -0.1]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a))
  })
})
