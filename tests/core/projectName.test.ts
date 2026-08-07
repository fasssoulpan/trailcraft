import { describe, it, expect } from 'vitest'
import { DEFAULT_PROJECT_NAME, deriveDefaultProjectName } from '../../src/ui/projectName'

describe('deriveDefaultProjectName', () => {
  it('uses the active track name when present', () => {
    expect(deriveDefaultProjectName('顺义50K')).toBe('顺义50K')
  })

  it('falls back to the fixed literal when there is no active track', () => {
    expect(deriveDefaultProjectName(undefined)).toBe(DEFAULT_PROJECT_NAME)
  })

  it('falls back to the fixed literal for an empty or whitespace-only track name', () => {
    expect(deriveDefaultProjectName('')).toBe(DEFAULT_PROJECT_NAME)
    expect(deriveDefaultProjectName('   ')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('trims surrounding whitespace from a real track name', () => {
    expect(deriveDefaultProjectName('  顺义50K  ')).toBe('顺义50K')
  })
})
