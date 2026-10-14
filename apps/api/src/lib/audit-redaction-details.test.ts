import type { ConnectRequest } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { auditedAdapterFactory, summarise, withAudit } from './audit.ts'
import { createLogger } from './logging.ts'

/**
 * What an audit line may keep of a statement that carries a password, and how the wrapper hands out an adapter
 * (found as surviving mutants; see `bun run mutation`). The line is written even when the statement fails to run,
 * so an unfinished literal is as much a place for a secret as a finished one.
 */

const ns = { database: 'shop' }
const logged = (sql: string, dialect: 'mysql' | 'postgres' = 'mysql') =>
  (summarise('executeSql', [ns, sql, undefined], dialect) as { sql: string }).sql
const M = PASSWORD_MASK

describe('a literal that never closes leaves nothing of the password behind', () => {
  it('masks all that follows an opening quote whose closing quote is escaped, and what follows it', () => {
    // `\'` is a quote character inside the string in MySQL, so this string is not closed: `def` is part of the secret.
    expect(logged("ALTER USER u IDENTIFIED BY 'abc\\'def")).toBe(`ALTER USER u IDENTIFIED BY '${M}'`)
    expect(logged('ALTER USER u IDENTIFIED BY "abc\\"def')).toBe(`ALTER USER u IDENTIFIED BY '${M}'`)
    expect(logged("ALTER USER u IDENTIFIED BY 'abc\\'def\\'ghi")).not.toMatch(/def|ghi/)
  })

  it('reads a quote right after the closing one as a doubled quote, so the string is still open', () => {
    // `''` is one quote character inside the string: `'abc''def` never closes, and `def` is part of the secret.
    expect(logged("ALTER USER u IDENTIFIED BY 'abc''def")).toBe(`ALTER USER u IDENTIFIED BY '${M}'`)
    expect(logged('ALTER USER u IDENTIFIED BY "abc""def')).toBe(`ALTER USER u IDENTIFIED BY '${M}'`)
    expect(logged("ALTER USER u IDENTIFIED BY 'abc'' WITH GRANT OPTION")).toBe(`ALTER USER u IDENTIFIED BY '${M}'`)
    // Closed after the doubled quote: the tail after the string stays.
    expect(logged("ALTER USER u IDENTIFIED BY 'abc''def' WITH GRANT OPTION")).toBe(
      `ALTER USER u IDENTIFIED BY '${M}' WITH GRANT OPTION`
    )
    expect(logged("ALTER USER u IDENTIFIED BY '' WITH GRANT OPTION")).toBe(
      `ALTER USER u IDENTIFIED BY '${M}' WITH GRANT OPTION`
    )
  })

  it('masks a quote that stands alone after the keyword', () => {
    expect(logged("x IDENTIFIED'")).toBe(`x IDENTIFIED'${M}'`)
    expect(logged('x IDENTIFIED"')).toBe(`x IDENTIFIED'${M}'`)
  })

  it('masks the rest of a statement from a dollar that closes no tag, and keeps a closed literal whole', () => {
    expect(logged('ALTER ROLE u PASSWORD $tag$abc', 'postgres')).toBe(`ALTER ROLE u PASSWORD '${M}'`)
    expect(logged("ALTER ROLE u PASSWORD $$ab'c", 'postgres')).toBe(`ALTER ROLE u PASSWORD '${M}'`)
  })
})

describe('a literal that closes is masked whole, and what follows it is kept', () => {
  it('when it does not follow the keyword directly (so the keyword pattern did not take it)', () => {
    expect(logged("CREATE USER u IDENTIFIED BY CONCAT($a$x$a$, 'y') WITH GRANT OPTION")).toBe(
      `CREATE USER u IDENTIFIED BY CONCAT('${M}') WITH GRANT OPTION`
    )
    expect(logged("CREATE USER u IDENTIFIED BY CONCAT('x', 'y') WITH GRANT OPTION")).toBe(
      `CREATE USER u IDENTIFIED BY CONCAT('${M}') WITH GRANT OPTION`
    )
    expect(logged('CREATE USER u IDENTIFIED BY CONCAT($a$x$a$) WITH GRANT OPTION', 'postgres')).toBe(
      `CREATE USER u IDENTIFIED BY CONCAT('${M}') WITH GRANT OPTION`
    )
  })

  it('only after the credential keyword: the account name before it stays', () => {
    expect(logged("CREATE USER 'bob'@'h' IDENTIFIED BY 'pw' REQUIRE SSL")).toBe(
      `CREATE USER 'bob'@'h' IDENTIFIED BY '${M}' REQUIRE SSL`
    )
  })
})

describe('the wrapper', () => {
  it('calls a method that is not audited on the adapter itself, so its private state is reachable', () => {
    class WithPrivate {
      #secret = 'inside'
      read() {
        return this.#secret
      }
    }
    const lines: string[] = []
    const wrapped = withAudit(
      new WithPrivate() as never,
      { dialect: 'mysql', host: 'h', port: 1, user: 'u' },
      createLogger('json', (l) => lines.push(l))
    ) as unknown as WithPrivate
    expect(wrapped.read()).toBe('inside')
    expect(lines).toEqual([])
  })

  it('is what a session store gets from the audited factory: the line carries the identity, never the password', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
    const config: ConnectRequest = { dialect: 'postgres', host: 'db', port: 5432, user: 'admin', password: 'hunter2' }
    const seen: ConnectRequest[] = []
    const factory = auditedAdapterFactory((c) => {
      seen.push(c)
      return { killProcess: async () => undefined } as never
    }, logger)
    const adapter = factory(config)
    expect(seen).toEqual([config])
    await adapter.killProcess('7', 'query')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: 'audit',
      action: 'killProcess',
      dialect: 'postgres',
      dbHost: 'db:5432',
      dbUser: 'admin',
      processId: '7',
      killMode: 'query',
      ok: true,
    })
    expect(JSON.stringify(lines)).not.toContain('hunter2')
  })
})
