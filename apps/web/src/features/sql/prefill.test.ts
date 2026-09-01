import { describe, expect, it } from 'vitest'
import { selectAllPrefill } from './prefill.ts'

describe('selectAllPrefill', () => {
  it('quotes per dialect and qualifies PostgreSQL with the schema', () => {
    expect(selectAllPrefill('mysql', 'we`ird')).toBe('SELECT * FROM `we``ird` LIMIT 100')
    expect(selectAllPrefill('postgres', 'users')).toBe('SELECT * FROM "public"."users" LIMIT 100')
    expect(selectAllPrefill('postgres', 'a"b', 'app')).toBe('SELECT * FROM "app"."a""b" LIMIT 100')
  })
})
