import { describe, expect, it } from 'vitest'
import { clearHistory, HISTORY_LIMIT, loadHistory, pushHistory } from './history.ts'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe('sql history', () => {
  it('prepends, de-duplicates and keeps dialects separate', () => {
    const s = memoryStorage()
    pushHistory('mysql', { sql: 'SELECT 1', at: 1, ok: true }, s)
    pushHistory('mysql', { sql: 'SELECT 2', at: 2, ok: false }, s)
    const list = pushHistory('mysql', { sql: 'SELECT 1', at: 3, ok: true }, s)
    expect(list.map((e) => e.sql)).toEqual(['SELECT 1', 'SELECT 2'])
    expect(list[0]?.at).toBe(3)
    expect(loadHistory('postgres', s)).toEqual([])
  })

  it('trims to the limit', () => {
    const s = memoryStorage()
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) pushHistory('postgres', { sql: `SELECT ${i}`, at: i, ok: true }, s)
    expect(loadHistory('postgres', s)).toHaveLength(HISTORY_LIMIT)
    expect(loadHistory('postgres', s)[0]?.sql).toBe(`SELECT ${HISTORY_LIMIT + 9}`)
  })

  it('ignores corrupt storage and can be cleared', () => {
    const s = memoryStorage()
    s.setItem('tsmyadmin.pref.sql.history.mysql', '{not json')
    expect(loadHistory('mysql', s)).toEqual([])
    // A list with a malformed entry is discarded as a whole (schema-validated like every preference).
    s.setItem('tsmyadmin.pref.sql.history.mysql', JSON.stringify([{ sql: 'ok', at: 1, ok: true }, { bad: true }]))
    expect(loadHistory('mysql', s)).toEqual([])
    s.setItem('tsmyadmin.pref.sql.history.mysql', JSON.stringify([{ sql: 'ok', at: 1, ok: true }]))
    expect(loadHistory('mysql', s)).toEqual([{ sql: 'ok', at: 1, ok: true }])
    clearHistory('mysql', s)
    expect(loadHistory('mysql', s)).toEqual([])
  })
})
