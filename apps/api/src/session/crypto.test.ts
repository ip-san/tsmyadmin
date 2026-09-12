import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveSessionKey, open, openLegacy, rowAad, seal } from './crypto.ts'

const aad = rowAad('sessions', 'row-1')

describe('session crypto', () => {
  it('round-trips and never reuses an IV', () => {
    const key = deriveSessionKey('a-secret')
    const a = seal(key, '{"password":"pw"}', aad)
    const b = seal(key, '{"password":"pw"}', aad)
    expect(open(key, a, aad)).toBe('{"password":"pw"}')
    expect(a.equals(b)).toBe(false)
    expect(a.toString('utf8')).not.toContain('pw')
  })

  it('rejects tampering and a different secret', () => {
    const key = deriveSessionKey('a-secret')
    const sealed = seal(key, 'hello', aad)
    const tampered = Buffer.from(sealed)
    const last = tampered.length - 1
    tampered[last] = (tampered[last] ?? 0) ^ 0xff
    expect(() => open(key, tampered, aad)).toThrow()
    expect(() => open(deriveSessionKey('other'), sealed, aad)).toThrow()
    expect(() => open(key, Buffer.alloc(3), aad)).toThrow(/too short/)
  })

  it('refuses a payload moved to another row, which is the attack it exists to stop', () => {
    const key = deriveSessionKey('a-secret')
    // Someone who can write the file but not decrypt it copies the victim's payload over their own row.
    const victim = seal(key, '{"password":"victim"}', rowAad('sessions', 'victim-row'))
    expect(() => open(key, victim, rowAad('sessions', 'attacker-row'))).toThrow()
    // Nor across tables: a saved query's payload cannot become a session's credentials.
    const bookmark = seal(key, '{"sql":"SELECT 1"}', rowAad('saved_queries', 'row-1'))
    expect(() => open(key, bookmark, rowAad('sessions', 'row-1'))).toThrow()
    // The row it was written for still opens.
    expect(open(key, victim, rowAad('sessions', 'victim-row'))).toBe('{"password":"victim"}')
  })

  it('reads a payload written before rows were bound, and only through openLegacy', () => {
    const key = deriveSessionKey('a-secret')
    // What the previous format produced: sealed with no AAD at all.
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update('{"password":"old"}', 'utf8'), cipher.final()])
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), body])
    expect(openLegacy(key, legacy)).toBe('{"password":"old"}')
    // The migration is the only thing that may read it; the bound reader refuses it.
    expect(() => open(key, legacy, aad)).toThrow()
  })

  it('binds to the row, not merely to the table name', () => {
    expect(rowAad('sessions', 'a').equals(rowAad('sessions', 'b'))).toBe(false)
    expect(rowAad('sessions', 'a').equals(rowAad('saved_queries', 'a'))).toBe(false)
  })

  it('renders the binding exactly as the rows on disk were sealed with', () => {
    // Pinned literally. Changing this format does not re-run the migration (the file still says format 2), so
    // every bound row would stop opening at once: sessions dropped, saved queries dropped.
    expect(rowAad('sessions', 'x').toString('utf8')).toBe('tsmyadmin:sessions:x')
    expect(rowAad('saved_queries', 'x').toString('utf8')).toBe('tsmyadmin:saved_queries:x')
  })
})
