import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consoleDraftKey, setDatabaseConsoleDraft, takeConsoleAutorun } from './console-draft.ts'

describe('console autorun', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => sessionStorage.clear())

  it('hands a statement over once', () => {
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'EXPLAIN SELECT 1', true)
    const key = consoleDraftKey('mysql.h.1', 'shop', undefined, 'db')
    expect(takeConsoleAutorun(key)).toBe('EXPLAIN SELECT 1')
    expect(takeConsoleAutorun(key)).toBeNull()
  })

  it('does not ask for a run unless told to', () => {
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 1')
    expect(takeConsoleAutorun(consoleDraftKey('mysql.h.1', 'shop', undefined, 'db'))).toBeNull()
  })
})
