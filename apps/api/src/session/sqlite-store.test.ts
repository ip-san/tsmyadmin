import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveSessionKey, open, openLegacy, rowAad } from './crypto.ts'
import { SqliteSessionStore } from './sqlite-store.ts'

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret-pw' }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmyadmin-sessions-'))
  dirs.push(dir)
  return join(dir, 'nested', 'sessions.sqlite')
}
/** What the release before row binding wrote: iv | tag | ciphertext, with no AAD. */
const legacySeal = (key: Buffer, plaintext: string) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

const factory =
  (made: FakeAdapter[] = []) =>
  () => {
    const a = new FakeAdapter()
    made.push(a)
    return a
  }

describe('SqliteSessionStore', () => {
  it('caps live sessions per database account across the persisted rows', async () => {
    const made: FakeAdapter[] = []
    let t = 0
    const path = tmpFile()
    const store = new SqliteSessionStore({
      path,
      secret: 's',
      adapterFactory: factory(made),
      maxPerIdentity: 2,
      sweepIntervalMs: 0,
      now: () => t++,
    })
    const a = await store.create(config)
    await store.create(config)
    await store.create(config)
    expect(await store.get(a.id)).toBeUndefined()
    expect(made[0]?.closed).toBe(true)
    expect(store.size).toBe(2)
    // Identity is stored as an HMAC, never the user/host in clear.
    const raw = new DatabaseSync(path)
    const rows = raw.prepare('SELECT identity FROM sessions').all() as { identity: string }[]
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.identity))).toBe(true)
    raw.close()
    await store.closeAll()
  })

  it('adds the identity column to a pre-0.2 sessions table', async () => {
    const path = tmpFile()
    mkdirSync(dirname(path), { recursive: true })
    const legacy = new DatabaseSync(path)
    legacy.exec(
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, payload BLOB NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)'
    )
    legacy.close()
    const store = new SqliteSessionStore({ path, secret: 's', adapterFactory: factory(), sweepIntervalMs: 0 })
    const s = await store.create(config)
    expect((await store.get(s.id))?.id).toBe(s.id)
    await store.closeAll()
  })

  it('creates, fetches, deletes and closes adapters like the memory store', async () => {
    const made: FakeAdapter[] = []
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      adapterFactory: factory(made),
      sweepIntervalMs: 0,
    })
    const s = await store.create(config)
    expect((await store.get(s.id))?.adapter).toBe(made[0])
    expect((await store.get(s.id))?.config.password).toBe('secret-pw')
    await store.delete(s.id)
    expect(await store.get(s.id)).toBeUndefined()
    expect(made[0]?.closed).toBe(true)
    await store.ping()
    await store.closeAll()
  })

  it('drops saved queries when SESSION_SECRET is rotated, instead of orphaning them', async () => {
    const path = tmpFile()
    const first = new SqliteSessionStore({ path, secret: 's'.repeat(32), adapterFactory: factory() })
    try {
      first.savedQueries.save(config, 'daily', 'SELECT 1')
    } finally {
      await first.closeAll()
    }

    // A new secret changes the identity HMAC, so nothing could ever address the old rows again.
    const rotated = new SqliteSessionStore({ path, secret: 'r'.repeat(32), adapterFactory: factory() })
    try {
      expect(rotated.secretRotated).toBe(true)
      expect(rotated.savedQueries.list(config)).toEqual([])
      const raw = new DatabaseSync(path)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM saved_queries').get()).toEqual({ n: 0 })
      raw.close()
    } finally {
      await rotated.closeAll()
    }
  })

  it('rotates the secret on a file written before saved queries existed', async () => {
    // The purge runs against a table a 0.1.x file has never had, so opening one must not throw.
    const path = tmpFile()
    const before = new SqliteSessionStore({ path, secret: 's'.repeat(32), adapterFactory: factory() })
    await before.closeAll()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE saved_queries')
    raw.close()

    const store = new SqliteSessionStore({ path, secret: 'r'.repeat(32), adapterFactory: factory() })
    try {
      expect(store.secretRotated).toBe(true)
      expect(store.savedQueries.list(config)).toEqual([])
      expect(store.savedQueries.save(config, 'daily', 'SELECT 1')).toHaveLength(1)
    } finally {
      await store.closeAll()
    }
  })

  it('carries sessions and saved queries across the row-binding upgrade', async () => {
    const path = tmpFile()
    const secret = 's'.repeat(32)
    let sessionId = ''
    const before = new SqliteSessionStore({ path, secret, adapterFactory: factory() })
    try {
      sessionId = (await before.create(config)).id
      before.savedQueries.save(config, 'daily', 'SELECT 1')
    } finally {
      await before.closeAll()
    }

    // Rewind the file to what the previous release wrote: payloads sealed without their row, and no format mark.
    const key = deriveSessionKey(secret)
    const raw = new DatabaseSync(path)
    for (const table of ['sessions', 'saved_queries']) {
      const rows = raw.prepare(`SELECT id, payload FROM ${table}`).all() as { id: string; payload: Uint8Array }[]
      const update = raw.prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`)
      for (const row of rows) {
        update.run(legacySeal(key, open(key, row.payload, rowAad(table, row.id))), row.id)
      }
    }
    raw.prepare("DELETE FROM meta WHERE key = 'payload_format'").run()
    raw.close()

    const after = new SqliteSessionStore({ path, secret, adapterFactory: factory() })
    try {
      // Nobody is signed out and nobody loses a bookmark.
      expect(after.secretRotated).toBe(false)
      expect((await after.get(sessionId))?.config.user).toBe(config.user)
      expect(after.savedQueries.list(config)).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }])
      // And the rows are bound now: the same payload in another row no longer opens.
      const check = new DatabaseSync(path)
      const row = check.prepare('SELECT id, payload FROM sessions LIMIT 1').get() as {
        id: string
        payload: Uint8Array
      }
      expect(() => open(key, row.payload, rowAad('sessions', 'another-row'))).toThrow()
      expect(open(key, row.payload, rowAad('sessions', row.id))).toContain(config.user)
      check.close()
    } finally {
      await after.closeAll()
    }
  })

  it("refuses a session payload copied into another account's row", async () => {
    const path = tmpFile()
    const secret = 's'.repeat(32)
    const store = new SqliteSessionStore({ path, secret, adapterFactory: factory() })
    const victim = await store.create(config)
    const attacker = await store.create({ ...config, user: 'attacker' })
    // Someone able to write the file but not to decrypt it swaps one payload for another.
    const raw = new DatabaseSync(path)
    const payload = (raw.prepare('SELECT payload FROM sessions WHERE id = ?').get(victim.id) as { payload: Uint8Array })
      .payload
    raw.prepare('UPDATE sessions SET payload = ? WHERE id = ?').run(payload, attacker.id)
    raw.close()
    await store.closeAll()

    // After a restart the row is read from the file: it cannot be opened for that row, so it is dropped rather
    // than handing the attacker a session running as the victim.
    const reopened = new SqliteSessionStore({ path, secret, adapterFactory: factory() })
    try {
      expect(await reopened.get(attacker.id)).toBeUndefined()
      expect((await reopened.get(victim.id))?.config.user).toBe(config.user)
    } finally {
      await reopened.closeAll()
    }
  })

  it('leaves a rolled-back image a readable file, not a broken one', async () => {
    // What deployment.md promises about going back past this release. An older image opens payloads with no
    // AAD, so it can read none of them; what matters is that it does not decide the secret changed and wipe
    // the file, and that the saved-query rows survive for a roll forward.
    const path = tmpFile()
    const secret = 's'.repeat(32)
    const store = new SqliteSessionStore({ path, secret, adapterFactory: factory() })
    try {
      await store.create(config)
      store.savedQueries.save(config, 'daily', 'SELECT 1')
    } finally {
      await store.closeAll()
    }

    const key = deriveSessionKey(secret)
    const raw = new DatabaseSync(path)
    try {
      // The fingerprint is what the older image checks, and it still matches: no rotation, no purge.
      const meta = raw.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
      expect(meta.map((m) => m.key).sort()).toEqual(['key_fingerprint', 'payload_format'])
      // And it genuinely cannot read the payloads, which is why those rows go rather than being handed over.
      for (const table of ['sessions', 'saved_queries']) {
        const rows = raw.prepare(`SELECT payload FROM ${table}`).all() as { payload: Uint8Array }[]
        expect(rows).toHaveLength(1)
        expect(() => openLegacy(key, rows[0]?.payload ?? new Uint8Array())).toThrow()
      }
    } finally {
      raw.close()
    }
  })

  it('keeps saved queries per account, sealed, and capped', async () => {
    const path = tmpFile()
    const store = new SqliteSessionStore({ path, secret: 's'.repeat(32), adapterFactory: factory() })
    const other = { ...config, user: 'someone-else' }
    try {
      const saved = store.savedQueries.save(config, 'recent users', "SELECT * FROM users WHERE note = 'x'")
      expect(saved).toMatchObject([{ name: 'recent users' }])
      expect(saved[0]?.id).toBeTruthy()
      // Saving the same name replaces it rather than adding a second row.
      expect(store.savedQueries.save(config, 'recent users', 'SELECT 2')).toHaveLength(1)
      expect(store.savedQueries.list(config)[0]?.sql).toBe('SELECT 2')

      // Another account sees nothing of it, and cannot delete it by id.
      expect(store.savedQueries.list(other)).toEqual([])
      store.savedQueries.remove(other, saved[0]?.id ?? '')
      expect(store.savedQueries.list(config)).toHaveLength(1)

      // Neither the statement nor the account name is readable in the file.
      const raw = new DatabaseSync(path)
      const rows = raw.prepare('SELECT identity, payload FROM saved_queries').all() as {
        identity: string
        payload: Uint8Array
      }[]
      const bytes = Buffer.concat(rows.map((r) => Buffer.from(r.payload))).toString('latin1')
      expect(bytes).not.toContain('SELECT')
      expect(rows.map((r) => r.identity).join()).not.toContain(config.user)
      raw.close()

      store.savedQueries.remove(config, saved[0]?.id ?? '')
      expect(store.savedQueries.list(config)).toEqual([])
    } finally {
      await store.closeAll()
    }
  })

  it('stores credentials encrypted at rest', async () => {
    const path = tmpFile()
    const store = new SqliteSessionStore({ path, secret: 's', adapterFactory: factory(), sweepIntervalMs: 0 })
    await store.create(config)
    await store.closeAll()
    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT payload FROM sessions').get() as { payload: Uint8Array }
    expect(Buffer.from(row.payload).toString('utf8')).not.toContain('secret-pw')
    raw.close()
  })

  it('survives a restart: a new process rebuilds the adapter once from the stored config', async () => {
    const path = tmpFile()
    const first = new SqliteSessionStore({ path, secret: 's', adapterFactory: factory(), sweepIntervalMs: 0 })
    const s = await first.create(config)
    await first.closeAll()

    const rebuilt: FakeAdapter[] = []
    const second = new SqliteSessionStore({
      path,
      secret: 's',
      adapterFactory: (cfg) => {
        expect(cfg).toEqual(config)
        return factory(rebuilt)()
      },
      sweepIntervalMs: 0,
    })
    const resumed = await second.get(s.id)
    expect(resumed?.config.user).toBe('u')
    expect(rebuilt).toHaveLength(1)
    expect((await second.get(s.id))?.adapter).toBe(rebuilt[0]) // cached: no second rebuild, no second decrypt
    await second.closeAll()
  })

  it('purges every row sealed with a different secret when the store opens', async () => {
    const path = tmpFile()
    const a = new SqliteSessionStore({ path, secret: 'one', adapterFactory: factory(), sweepIntervalMs: 0 })
    const s = await a.create(config)
    await a.create(config)
    expect(a.secretRotated).toBe(false)
    await a.closeAll()
    // Same secret: rows survive the restart untouched.
    const same = new SqliteSessionStore({ path, secret: 'one', adapterFactory: factory(), sweepIntervalMs: 0 })
    expect(same.secretRotated).toBe(false)
    expect(same.size).toBe(2)
    await same.closeAll()
    // Rotated secret: the rows are deleted up front (not left until a lookup or the TTL sweep).
    const b = new SqliteSessionStore({ path, secret: 'two', adapterFactory: factory(), sweepIntervalMs: 0 })
    expect(b.secretRotated).toBe(true)
    expect(b.size).toBe(0)
    expect(await b.get(s.id)).toBeUndefined()
    await b.closeAll()
  })

  it('purges a pre-fingerprint (0.1.0) file whose rows no longer decrypt', async () => {
    const path = tmpFile()
    const a = new SqliteSessionStore({ path, secret: 'one', adapterFactory: factory(), sweepIntervalMs: 0 })
    await a.create(config)
    await a.closeAll()
    new DatabaseSync(path).exec('DROP TABLE meta')
    const same = new SqliteSessionStore({ path, secret: 'one', adapterFactory: factory(), sweepIntervalMs: 0 })
    expect(same.secretRotated).toBe(false)
    expect(same.size).toBe(1)
    await same.closeAll()
    new DatabaseSync(path).exec('DROP TABLE meta')
    const rotated = new SqliteSessionStore({ path, secret: 'two', adapterFactory: factory(), sweepIntervalMs: 0 })
    expect(rotated.secretRotated).toBe(true)
    expect(rotated.size).toBe(0)
    await rotated.closeAll()
  })

  it('applies a sliding TTL, throttles touch writes and sweeps stale rows', async () => {
    let t = 1000
    const made: FakeAdapter[] = []
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      adapterFactory: factory(made),
      ttlMs: 100,
      touchIntervalMs: 50,
      sweepIntervalMs: 0,
      now: () => t,
    })
    const s = await store.create(config)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // touched (80 ≥ 50)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // still alive thanks to the touch
    t += 150
    expect(await store.get(s.id)).toBeUndefined()
    expect(made[0]?.closed).toBe(true)

    const sb = await store.create(config)
    t += 200
    await store.sweep()
    expect(store.size).toBe(0)
    expect(made[1]?.closed).toBe(true)
    expect(await store.get(sb.id)).toBeUndefined()
    await store.closeAll()
  })
})
