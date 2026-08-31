import { describe, it, expect } from 'vitest'
import { SCRAPER_VERSION } from '../src/version.ts'

describe('workspace', () => {
  it('resolves workspace-internal imports', () => {
    expect(SCRAPER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
