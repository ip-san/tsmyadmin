import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consoleDraftKey, setDatabaseConsoleDraft, takeConsoleArrival } from './console-draft.ts'

describe('console autorun', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => sessionStorage.clear())

  it('hands a statement over once', () => {
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'EXPLAIN SELECT 1', 'run')
    const key = consoleDraftKey('mysql.h.1', 'shop', undefined, 'db')
    expect(takeConsoleArrival(key, 'plan')).toBeNull()
    expect(takeConsoleArrival(key, 'run')).toBe('EXPLAIN SELECT 1')
    expect(takeConsoleArrival(key, 'run')).toBeNull()
  })

  it('hands a statement over to draw its plan, not to run it', () => {
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 1', 'plan')
    const key = consoleDraftKey('mysql.h.1', 'shop', undefined, 'db')
    expect(takeConsoleArrival(key, 'run')).toBeNull()
    expect(takeConsoleArrival(key, 'plan')).toBe('SELECT 1')
    expect(takeConsoleArrival(key, 'plan')).toBeNull()
  })

  it('drops what an earlier hand-over asked for and the console never read', () => {
    const key = consoleDraftKey('mysql.h.1', 'shop', undefined, 'db')
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'EXPLAIN SELECT 1', 'run')
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 2', 'plan')
    expect(takeConsoleArrival(key, 'run')).toBeNull()
    expect(takeConsoleArrival(key, 'plan')).toBe('SELECT 2')
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 3', 'plan')
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 4')
    expect(takeConsoleArrival(key, 'plan')).toBeNull()
  })

  it('does not ask for a run unless told to', () => {
    setDatabaseConsoleDraft('mysql.h.1', 'shop', undefined, 'SELECT 1')
    const key = consoleDraftKey('mysql.h.1', 'shop', undefined, 'db')
    expect(takeConsoleArrival(key, 'run')).toBeNull()
    expect(takeConsoleArrival(key, 'plan')).toBeNull()
  })
})
