import { SAVED_QUERY_MAX_SQL } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { deleteSaved, loadSaved, saveQuery } from './saved-queries.ts'

function memoryStore() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('saved queries', () => {
  it('saves newest first, replaces by name and deletes', () => {
    const s = memoryStore()
    saveQuery('mysql', { id: '', name: 'a', sql: 'SELECT 1', at: 1 }, s)
    saveQuery('mysql', { id: '', name: 'b', sql: 'SELECT 2', at: 2 }, s)
    expect(loadSaved('mysql', s).map((q) => q.name)).toEqual(['b', 'a'])
    saveQuery('mysql', { id: '', name: 'a', sql: 'SELECT 11', at: 3 }, s)
    expect(loadSaved('mysql', s).map((q) => q.sql)).toEqual(['SELECT 11', 'SELECT 2'])
    expect(deleteSaved('mysql', 'b', s).map((q) => q.name)).toEqual(['a'])
    expect(loadSaved('postgres', s)).toEqual([])
  })

  it('keeps a list holding a statement longer than the server would accept', () => {
    // The server caps what it will store; this browser's own list predates that cap, and an entry over it must
    // not take the rest of the list with it.
    const s = memoryStore()
    saveQuery('mysql', { id: '', name: 'short', sql: 'SELECT 1', at: 1 }, s)
    saveQuery('mysql', { id: '', name: 'huge', sql: `SELECT ${'x'.repeat(SAVED_QUERY_MAX_SQL)}`, at: 2 }, s)
    expect(loadSaved('mysql', s).map((q) => q.name)).toEqual(['huge', 'short'])
  })

  it('drops only the unreadable entries of a hand-edited list', () => {
    const s = memoryStore()
    s.setItem(
      'tsmyadmin.pref.sql.saved.mysql',
      JSON.stringify([{ name: 'ok', sql: 'SELECT 1', at: 1 }, { name: 'broken' }, 'not an object'])
    )
    expect(loadSaved('mysql', s).map((q) => q.name)).toEqual(['ok'])
  })
})
