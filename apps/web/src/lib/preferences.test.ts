import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readPreference, writePreference } from './preferences.ts'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  }
}

describe('preferences', () => {
  it('round-trips values under a namespaced key', () => {
    const store = memoryStore()
    writePreference('limit', 250, store)
    expect(store.data.get('tsmyadmin.pref.limit')).toBe('250')
    expect(readPreference('limit', z.number(), 50, store)).toBe(250)
  })

  it('falls back when the value is missing, malformed or fails validation', () => {
    expect(readPreference('limit', z.number(), 50, memoryStore())).toBe(50)
    expect(readPreference('limit', z.number(), 50, memoryStore({ 'tsmyadmin.pref.limit': '{bad' }))).toBe(50)
    expect(readPreference('limit', z.number().max(10), 50, memoryStore({ 'tsmyadmin.pref.limit': '999' }))).toBe(50)
  })

  it('swallows storage failures', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => undefined,
    }
    expect(() => writePreference('x', 1, broken)).not.toThrow()
    expect(readPreference('x', z.number(), 7, broken)).toBe(7)
  })
})
