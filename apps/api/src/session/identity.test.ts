import type { ConnectRequest } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { deriveSessionKey } from './crypto.ts'
import { identityHash, identityKey } from './identity.ts'

const account = (over: Partial<ConnectRequest> = {}): ConnectRequest => ({
  dialect: 'mysql',
  host: 'db.internal',
  port: 3306,
  user: 'app',
  password: 'pw',
  ...over,
})

describe('account identity', () => {
  it('renders a plain account exactly as it did before the fields were escaped', () => {
    // Pinned literally: this value is the HMAC input for every stored session and saved query, so changing it
    // would sign everyone out and orphan their bookmarks. Escaping must be a no-op for ordinary accounts.
    expect(identityKey(account())).toBe('mysql|db.internal|3306|app')
    expect(identityKey(account({ dialect: 'postgres', host: 'DB.Example.COM', port: 5432, user: 'reader' }))).toBe(
      'postgres|db.example.com|5432|reader'
    )
  })

  it('never renders two different accounts the same way', () => {
    // A real collision in the un-escaped form: the host carries what looks like a separator, the port and
    // another separator, so it swallows the port field and the two tuples render identically.
    //   `mysql` + `|h|3306|u|` + `3306` + `|v`   ==   `mysql` + `|h|` + `3306` + `|u|3306|v`
    // Nothing in this function required the host to be resolvable or the port to be digits, so the format was
    // relying on validation elsewhere to stay unambiguous. Escaping removes that dependency.
    expect(identityKey(account({ host: 'h|3306|u', port: 3306, user: 'v' }))).not.toBe(
      identityKey(account({ host: 'h', port: 3306, user: 'u|3306|v' }))
    )
    // The backslash half of the escaping has no collision to demonstrate here — with the port always numeric
    // and sitting between the host and the user, escaping `|` alone already separates every pair I could
    // construct. It is kept so the encoding is a whole, reversible escape rather than one that happens to work
    // because of a constraint enforced somewhere else, which is the dependency this was written to remove.
  })

  it('separates accounts that differ in any single field', () => {
    const base = identityKey(account())
    for (const over of [
      { dialect: 'postgres' as const },
      { host: 'other.internal' },
      { port: 3307 },
      { user: 'other' },
    ]) {
      expect(identityKey(account(over))).not.toBe(base)
    }
    // The password is not part of it: the same account with a changed password is still that account.
    expect(identityKey(account({ password: 'different' }))).toBe(base)
  })

  it('hashes under the key, so the file holds neither the user nor the host', () => {
    const key = deriveSessionKey('s'.repeat(32))
    const hash = identityHash(key, account())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('app')
    expect(hash).not.toContain('db.internal')
    expect(identityHash(deriveSessionKey('another'.repeat(5)), account())).not.toBe(hash)
  })
})
