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
    saveQuery('mysql', { name: 'a', sql: 'SELECT 1', at: 1 }, s)
    saveQuery('mysql', { name: 'b', sql: 'SELECT 2', at: 2 }, s)
    expect(loadSaved('mysql', s).map((q) => q.name)).toEqual(['b', 'a'])
    saveQuery('mysql', { name: 'a', sql: 'SELECT 11', at: 3 }, s)
    expect(loadSaved('mysql', s).map((q) => q.sql)).toEqual(['SELECT 11', 'SELECT 2'])
    expect(deleteSaved('mysql', 'b', s).map((q) => q.name)).toEqual(['a'])
    expect(loadSaved('postgres', s)).toEqual([])
  })
})
