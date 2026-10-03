import { COLUMN_PRIVILEGES } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlAccount } from '../../mysql/users.ts'
import { quoteIdent } from '../../sql/quote.ts'
import { type DatabaseAdapter } from '../../types.ts'
import type { ConformanceEnv } from './env.ts'
import { EXEC } from './helpers.ts'

/** Conformance: the blocks of `accounts` (in the order they have always run in). */
export function describeAccounts(env: ConformanceEnv): void {
  const { ctx, ns, dialect, scratch, exec, execOk, isMariaDb } = env
  describe('listUsers', () => {
    it('includes the connected account with attributes', async () => {
      const users = await env.db.listUsers()
      const me = users.find((u) => u.name === 'tsmyadmin')
      expect(me).toBeDefined()
      expect(me?.canLogin).toBe(true)
      expect(Array.isArray(me?.attributes)).toBe(true)
      expect(dialect === 'mysql' ? me?.host : me?.host === null).toBeTruthy()
    })
  })

  describe('showGrants', () => {
    it('returns grant statements for an account', async () => {
      const me = (await env.db.listUsers()).find((u) => u.name === 'tsmyadmin')
      const grants = await env.db.showGrants({ name: 'tsmyadmin', ...(me?.host ? { host: me.host } : {}) })
      expect(grants.length).toBeGreaterThan(0)
      expect(grants.join('\n')).toMatch(
        dialect === 'mysql' ? /GRANT .* ON \*\.\* TO/ : /ALTER ROLE "tsmyadmin" SUPERUSER/
      )
    })
  })

  describe('canManageAccount', () => {
    const q = (n: string) => quoteIdent(dialect, n)
    /** A login account of its own, created and dropped around each case. */
    const account = async (name: string, extra = '') => {
      // Reading the fixture database is only there so the connection opens; it grants no say over accounts.
      if (dialect === 'mysql')
        await execOk(
          `CREATE USER ${mysqlAccount({ name, host: '%' })} IDENTIFIED BY 'cm-pw'; GRANT SELECT ON ${q(ns.database)}.* TO ${mysqlAccount({ name, host: '%' })}`
        )
      else
        await execOk(
          `CREATE ROLE ${q(name)} LOGIN PASSWORD 'cm-pw' ${extra}; GRANT CONNECT ON DATABASE ${q(ns.database)} TO ${q(name)}`
        )
      return ctx.createAs(name, 'cm-pw')
    }
    const drop = async (...names: string[]) => {
      for (const name of names) {
        if (dialect === 'mysql') await exec(`DROP USER IF EXISTS ${mysqlAccount({ name, host: '%' })}`)
        else await exec(`DROP OWNED BY ${q(name)}; DROP ROLE IF EXISTS ${q(name)}`, { stopOnError: false })
      }
    }

    it('is true for the fixture account, and false for one without the authority', async () => {
      expect(await env.db.canManageAccount('tsmyadmin')).toBe(true)
      const name = `cm_${scratch}`
      const plain = await account(name)
      try {
        expect(await plain.canManageAccount('tsmyadmin')).toBe(false)
        expect(await plain.canManageAccount(name)).toBe(false)
      } finally {
        await plain.close()
        await drop(name)
      }
    })

    it('follows what the database itself would let that account alter', async () => {
      const name = `cm2_${scratch}`
      const other = `cm3_${scratch}`
      if (dialect === 'mysql') {
        const admin = await account(name)
        try {
          await execOk(`GRANT CREATE USER ON *.* TO ${mysqlAccount({ name, host: '%' })}`)
          // MySQL 8 protects SYSTEM_USER accounts from those without it; MariaDB has no such privilege.
          const mariadb = await isMariaDb()
          expect(await admin.canManageAccount('tsmyadmin')).toBe(mariadb)
          if (!mariadb) {
            await execOk(`GRANT SYSTEM_USER ON *.* TO ${mysqlAccount({ name, host: '%' })}`)
            expect(await admin.canManageAccount('tsmyadmin')).toBe(true)
          }
        } finally {
          await admin.close()
          await drop(name)
        }
        return
      }
      const admin = await account(name, 'CREATEROLE')
      const version = await exec('SHOW server_version_num')
      const numeric = version[0]?.kind === 'rows' ? Number(version[0].result.rows[0]?.[0]) : 0
      try {
        // Never a superuser, whatever else it may alter.
        expect(await admin.canManageAccount('tsmyadmin')).toBe(false)
        // A role it created itself: its own to manage on every version.
        const made = await admin.executeSql(ns, `CREATE ROLE ${q(other)} LOGIN`, EXEC)
        expect(made[0]?.kind).toBe('affected')
        expect(await admin.canManageAccount(other)).toBe(true)
        // One someone else created: from 16 on, CREATEROLE alone no longer reaches it.
        await execOk(`CREATE ROLE ${q(`${other}x`)} LOGIN`)
        expect(await admin.canManageAccount(`${other}x`)).toBe(numeric < 160000)
        // No role by that name: left to superusers.
        expect(await admin.canManageAccount(`${other}_missing`)).toBe(false)
      } finally {
        await admin.close()
        await drop(other, `${other}x`, name)
      }
    })
  })

  describe('users', () => {
    it('locks, limits, renames and copies an account, and edits its global and routine privileges', async () => {
      const name = `acc_${scratch}`
      const renamed = `${name}_rn`
      const copied = `${name}_cp`
      const fn = `${scratch}_accfn`
      const ref = (n: string) => (dialect === 'mysql' ? { name: n, host: '%' } : { name: n })
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((x) => x.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      const find = async (n: string) => (await env.db.listUsers()).find((u) => u.name === n)
      try {
        await runOp({
          op: 'createUser',
          user: ref(name),
          password: 'acc-pw-1',
          attributes: { superuser: false, createdb: false, createrole: false },
        })
        // Locked accounts cannot log in; unlocked ones can again.
        await runOp({ op: 'lockUser', user: ref(name), locked: true })
        expect((await find(name))?.canLogin).toBe(false)
        await runOp({ op: 'lockUser', user: ref(name), locked: false })
        expect((await find(name))?.canLogin).toBe(true)

        // Limits: MySQL's whole set, PostgreSQL's connection limit only (which refuses the rest).
        if (dialect === 'mysql') {
          await runOp({
            op: 'setAccountLimits',
            user: ref(name),
            require: 'SSL',
            maxQueries: 100,
            maxUserConnections: 3,
          })
          expect((await find(name))?.limits).toMatchObject({ require: 'SSL', maxQueries: 100, maxUserConnections: 3 })
          await runOp({
            op: 'setAccountLimits',
            user: ref(name),
            require: 'NONE',
            maxQueries: 0,
            maxUserConnections: 0,
          })
          expect((await find(name))?.limits).toMatchObject({ require: 'NONE', maxQueries: 0, maxUserConnections: 0 })
        } else {
          await runOp({ op: 'setAccountLimits', user: ref(name), maxUserConnections: 3 })
          expect((await find(name))?.limits?.maxUserConnections).toBe(3)
          expect(() => env.db.users.build({ op: 'setAccountLimits', user: ref(name), maxQueries: 5 })).toThrow(
            /limits only/
          )
        }

        // Global privileges (MySQL) / role attributes (PostgreSQL), one at a time.
        if (dialect === 'mysql') {
          await runOp({ op: 'changeGlobalPrivileges', user: ref(name), grant: ['PROCESS', 'RELOAD'], revoke: [] })
          const granted = (await env.db.showGrants(ref(name))).join('\n')
          expect(granted).toMatch(/PROCESS/)
          await runOp({ op: 'changeGlobalPrivileges', user: ref(name), grant: [], revoke: ['RELOAD'] })
          expect((await env.db.showGrants(ref(name))).join('\n')).not.toMatch(/RELOAD/)
        } else {
          await runOp({ op: 'alterRole', user: ref(name), createdb: true })
          expect((await find(name))?.attributes).toContain('CREATEDB')
          await runOp({ op: 'alterRole', user: ref(name), createdb: false })
          expect((await find(name))?.attributes).not.toContain('CREATEDB')
        }

        // Privileges on one routine.
        await execOk(
          dialect === 'mysql'
            ? `CREATE FUNCTION ${fn}(n INT) RETURNS INT DETERMINISTIC RETURN n`
            : `CREATE FUNCTION ${fn}(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n'`
        )
        const routine = {
          user: ref(name),
          privileges: ['EXECUTE' as const],
          database: ns.database,
          ...(ns.schema ? { schema: ns.schema } : {}),
          routine: fn,
          kind: 'FUNCTION' as const,
          ...(dialect === 'postgres' ? { parameters: 'n integer' } : {}),
        }
        await runOp({ op: 'grantRoutinePrivileges', ...routine })
        const acl = async () =>
          dialect === 'mysql'
            ? (await env.db.showGrants(ref(name))).join('\n')
            : String(
                (await exec(`SELECT proacl::text FROM pg_proc WHERE proname = '${fn}'`).then((r) => {
                  const first = r[0]
                  return first?.kind === 'rows' ? first.result.rows[0]?.[0] : ''
                })) ?? ''
              )
        expect(await acl()).toMatch(dialect === 'mysql' ? /EXECUTE ON FUNCTION/ : new RegExp(`${name}=X/`))
        await runOp({ op: 'revokeRoutinePrivileges', ...routine })
        expect(await acl()).not.toMatch(dialect === 'mysql' ? /EXECUTE ON FUNCTION/ : new RegExp(`${name}=X/`))

        // Renamed, then copied with what it holds.
        await runOp({ op: 'renameUser', user: ref(name), newUser: ref(renamed) })
        expect(await find(name)).toBeUndefined()
        expect(await find(renamed)).toBeDefined()
        await runOp({
          op: 'copyUser',
          user: ref(renamed),
          newUser: ref(copied),
          password: 'acc-pw-2',
          grants: await env.db.showGrants(ref(renamed)),
        })
        const copy = await find(copied)
        expect(copy).toBeDefined()
        expect(copy?.canLogin).toBe(true)
        if (dialect === 'mysql') expect((await env.db.showGrants(ref(copied))).join('\n')).toMatch(/PROCESS/)
      } finally {
        await exec(`DROP FUNCTION IF EXISTS ${fn}`, { stopOnError: false })
        for (const n of [name, renamed, copied])
          await exec(
            [
              ...(dialect === 'postgres'
                ? env.db.users.build({
                    op: 'revokeAll',
                    user: ref(n),
                    database: ns.database,
                    ...(ns.schema ? { schema: ns.schema } : {}),
                  })
                : []),
              ...env.db.users.build({ op: 'dropUser', user: ref(n) }),
            ]
              .map((x) => x.sql)
              .join(';\n'),
            { stopOnError: false }
          )
      }
    })

    it('creates an account with a database of its own name and a wildcard grant (MySQL)', async () => {
      if (dialect !== 'mysql') return
      const name = `own_${scratch}`.slice(0, 30)
      const user = { name, host: '%' }
      const build = env.db.users.build({
        op: 'createUser',
        user,
        password: 'own-pw',
        attributes: { superuser: false, createdb: false, createrole: false },
        createDatabase: true,
        grantWildcard: true,
      })
      try {
        for (const statement of build) await execOk(statement.sql)
        expect((await env.db.listDatabases()).map((d) => d.name)).toContain(name)
        const grants = (await env.db.showGrants(user)).join('\n')
        // The database's own name, and the wildcard over `name_…` (underscores escaped in the pattern).
        expect(grants).toContain(`${name}`)
        expect(grants).toMatch(/\\_%/)
      } finally {
        for (const statement of env.db.ddl.build(ns, { op: 'dropDatabase', name }))
          await exec(statement, { stopOnError: false })
        for (const statement of env.db.users.build({ op: 'dropUser', user }))
          await exec(statement.sql, { stopOnError: false })
      }
    })

    it('drops several accounts at once, taking their privileges away first and their same-named databases with them', async () => {
      const one = `bd1_${scratch}`.slice(0, 28)
      const two = `bd2_${scratch}`.slice(0, 28)
      const refs = [one, two].map((n) => (dialect === 'mysql' ? { name: n, host: '%' } : { name: n }))
      const attributes = { superuser: false, createdb: false, createrole: false }
      const listed = async () => new Set((await env.db.listUsers()).map((u) => u.name))
      try {
        for (const user of refs)
          for (const st of env.db.users.build({ op: 'createUser', user, password: 'bulk-pw-1', attributes }))
            await execOk(st.sql)
        // Holding a privilege on a table is what stops PostgreSQL from dropping a role; MySQL drops it anyway.
        for (const user of refs)
          await execOk(
            env.db.users.build({
              op: 'grantPrivileges',
              user,
              privileges: ['SELECT'],
              database: ns.database,
              ...(ns.schema ? { schema: ns.schema } : {}),
              table: scratch,
            })[0]?.sql ?? ''
          )
        if (dialect === 'postgres') {
          const refused = await exec(env.db.users.build({ op: 'dropUsers', users: refs })[0]?.sql ?? '', {
            stopOnError: false,
          })
          expect(refused[0]?.kind).toBe('error')
          expect(await listed()).toContain(one)
        }
        for (const st of env.db.users.build({ op: 'dropUsers', users: refs, revokeFirst: true })) await execOk(st.sql)
        const after = await listed()
        expect(after.has(one)).toBe(false)
        expect(after.has(two)).toBe(false)
      } finally {
        for (const user of refs)
          for (const st of env.db.users.build({ op: 'dropUser', user })) await exec(st.sql, { stopOnError: false })
      }
    })

    it("drops the database that has an account's name along with it (MySQL)", async () => {
      if (dialect !== 'mysql') return
      const name = `bdd_${scratch}`.slice(0, 28)
      const user = { name, host: '%' }
      try {
        for (const st of env.db.users.build({
          op: 'createUser',
          user,
          password: 'bulk-pw-2',
          attributes: { superuser: false, createdb: false, createrole: false },
          createDatabase: true,
        }))
          await execOk(st.sql)
        expect((await env.db.listDatabases()).map((d) => d.name)).toContain(name)
        for (const st of env.db.users.build({ op: 'dropUsers', users: [user], dropSameNameDatabases: true }))
          await execOk(st.sql)
        expect((await env.db.listDatabases()).map((d) => d.name)).not.toContain(name)
      } finally {
        for (const st of env.db.ddl.build(ns, { op: 'dropDatabase', name })) await exec(st, { stopOnError: false })
        for (const st of env.db.users.build({ op: 'dropUser', user })) await exec(st.sql, { stopOnError: false })
      }
    })

    it('grants exactly the privileges asked for: a read-only account can select but not write', async () => {
      // The point of per-table grants is this account. Checked by connecting as it, not by reading the SQL.
      const name = `ro_${scratch}`
      const password = 'r3ad only!'
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((x) => x.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      await runOp({
        op: 'createUser',
        user,
        password,
        attributes: { superuser: false, createdb: false, createrole: false },
      })
      let reader: DatabaseAdapter | undefined
      try {
        await runOp({
          op: 'grantPrivileges',
          user,
          privileges: ['SELECT'],
          database: ns.database,
          ...(ns.schema ? { schema: ns.schema } : {}),
          table: 'users',
        })
        reader = ctx.createAs(name, password)
        // Refused either as a failed statement or, once the account loses the database entirely, as a
        // connection that cannot be opened — both mean "not allowed".
        const refused = async (sql: string) => {
          try {
            const r = await (reader as DatabaseAdapter).executeSql(ns, sql, { ...EXEC, stopOnError: false })
            return r.some((x) => x.kind === 'error')
          } catch {
            return true
          }
        }
        const rows = await reader.executeSql(ns, 'SELECT COUNT(*) FROM users', EXEC)
        expect(rows[0]?.kind).toBe('rows')
        // Only what was granted: writing that table, and reading a different one, are both refused.
        expect(await refused('UPDATE users SET name = name WHERE id = -1')).toBe(true)
        expect(await refused('SELECT COUNT(*) FROM posts')).toBe(true)

        // Revoking it takes the read away again.
        await runOp({
          op: 'revokePrivileges',
          user,
          privileges: ['SELECT'],
          database: ns.database,
          ...(ns.schema ? { schema: ns.schema } : {}),
          table: 'users',
        })
        expect(await refused('SELECT COUNT(*) FROM users')).toBe(true)
      } finally {
        await reader?.close()
        // PostgreSQL refuses to drop a role that still holds privileges, so they go first.
        await exec(
          [
            ...env.db.users.build({
              op: 'revokeAll',
              user,
              database: ns.database,
              ...(ns.schema ? { schema: ns.schema } : {}),
            }),
            ...env.db.users.build({ op: 'dropUser', user }),
          ]
            .map((x) => x.sql)
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })

    it('creates an account a replica can connect with, and shows the replication right', async () => {
      const name = `repl_${scratch}`
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const op = {
        op: 'createUser',
        user,
        password: 'r3pl pw!',
        attributes: { superuser: false, createdb: false, createrole: false },
        replication: true,
      } as const
      try {
        const r = await env.db.executeSql(
          env.db.users.namespace(op, env.db.serverNamespace),
          env.db.users
            .build(op)
            .map((x) => x.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
        expect((await env.db.showGrants(user)).join('\n')).toMatch(
          dialect === 'mysql' ? /GRANT .*REPLICATION (SLAVE|REPLICA)/i : /ALTER ROLE .* REPLICATION/
        )
      } finally {
        await exec(
          env.db.users
            .build({ op: 'dropUser', user })
            .map((x) => x.sql)
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })

    it('grants WITH GRANT OPTION on a table, shows it, and takes only the grant option away again', async () => {
      const name = `gopt_${scratch}`
      const password = 'gr4nt opt!'
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((x) => x.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      const target = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), table: 'users' }
      await runOp({
        op: 'createUser',
        user,
        password,
        attributes: { superuser: false, createdb: false, createrole: false },
      })
      try {
        await runOp({ op: 'grantPrivileges', user, privileges: ['SELECT'], grantOption: true, ...target })
        const held = (await env.db.showGrants(user)).filter((g) => /users/.test(g))
        expect(held.join('\n')).toMatch(/GRANT SELECT ON .*users.* TO .* WITH GRANT OPTION/i)

        await runOp({ op: 'revokePrivileges', user, privileges: ['SELECT'], grantOption: true, ...target })
        const after = (await env.db.showGrants(user)).filter((g) => /users/.test(g))
        // The privilege is still held; only the right to pass it on is gone.
        expect(after.join('\n')).toMatch(/GRANT SELECT ON .*users/i)
        expect(after.join('\n')).not.toMatch(/WITH GRANT OPTION/i)
      } finally {
        await exec(
          [
            ...env.db.users.build({
              op: 'revokeAll',
              user,
              database: ns.database,
              ...(ns.schema ? { schema: ns.schema } : {}),
            }),
            ...env.db.users.build({ op: 'dropUser', user }),
          ]
            .map((x) => x.sql)
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })

    it('grants a named column only: the account reads that column and not its neighbours', async () => {
      const name = `col_${scratch}`
      const password = 'c0l only!'
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((x) => x.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      const target = { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}), table: 'users' }
      await runOp({
        op: 'createUser',
        user,
        password,
        attributes: { superuser: false, createdb: false, createrole: false },
      })
      let reader: DatabaseAdapter | undefined
      try {
        await runOp({ op: 'grantPrivileges', user, privileges: ['SELECT'], columns: ['name'], ...target })
        reader = ctx.createAs(name, password)
        const refused = async (sql: string) => {
          try {
            const r = await (reader as DatabaseAdapter).executeSql(ns, sql, { ...EXEC, stopOnError: false })
            return r.some((x) => x.kind === 'error')
          } catch {
            return true
          }
        }
        // Named columns, not COUNT(*): whether a bare count is allowed under a column grant differs by server
        // and is not what this is testing.
        const granted = await reader.executeSql(ns, 'SELECT name FROM users', EXEC)
        expect(granted[0]?.kind).toBe('rows')
        expect(await refused('SELECT email FROM users')).toBe(true)
        expect(await refused('SELECT * FROM users')).toBe(true)
        // The grant is per column *and* per privilege: reading `name` does not allow writing it.
        expect(await refused('UPDATE users SET name = name WHERE id = -1')).toBe(true)

        // The privileges screen reads showGrants, so a column grant has to be visible there or the feature
        // looks like it did nothing.
        expect((await env.db.showGrants(user)).join('\n')).toMatch(/GRANT SELECT \(.?name.?\) ON/i)

        await runOp({ op: 'revokePrivileges', user, privileges: ['SELECT'], columns: ['name'], ...target })
        expect(await refused('SELECT name FROM users')).toBe(true)
      } finally {
        await reader?.close()
        await exec(
          [
            ...env.db.users.build({
              op: 'revokeAll',
              user,
              database: ns.database,
              ...(ns.schema ? { schema: ns.schema } : {}),
            }),
            ...env.db.users.build({ op: 'dropUser', user }),
          ]
            .map((x) => x.sql)
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })

    it('accepts columns for exactly the privileges COLUMN_PRIVILEGES lists', async () => {
      // The closed list in `packages/shared` is a claim about both servers; this is the claim being checked.
      const name = `colset_${scratch}`
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const account = dialect === 'mysql' ? `'${name}'@'%'` : `"${name}"`
      const table = dialect === 'mysql' ? `\`${ns.database}\`.\`users\`` : `"${ns.schema ?? 'public'}"."users"`
      await exec(
        env.db.users
          .build({
            op: 'createUser',
            user,
            password: 'c0lset!',
            attributes: { superuser: false, createdb: false, createrole: false },
          })
          .map((x) => x.sql)
          .join(';\n')
      )
      try {
        const target = env.db.users.namespace(
          { op: 'grantPrivileges', user, privileges: ['SELECT'], database: ns.database },
          env.db.serverNamespace
        )
        const attempt = async (privilege: string, columns: boolean) => {
          const r = await env.db.executeSql(
            target,
            `GRANT ${privilege}${columns ? ' (name)' : ''} ON ${table} TO ${account}`,
            { ...EXEC, stopOnError: false }
          )
          return r.every((x) => x.kind !== 'error')
        }
        for (const privilege of COLUMN_PRIVILEGES) {
          expect([privilege, await attempt(privilege, true)]).toEqual([privilege, true])
        }
        // DELETE and TRIGGER act on the whole table, so naming a column is rejected. Each is also granted
        // *without* columns in the same breath: the column list is then the only difference between a
        // statement that works and one that does not, so this cannot pass because of some unrelated refusal
        // (a missing grant option, a mistyped table) that would have failed both forms.
        for (const privilege of ['DELETE', 'TRIGGER']) {
          expect([privilege, 'with columns', await attempt(privilege, true)]).toEqual([
            privilege,
            'with columns',
            false,
          ])
          expect([privilege, 'whole table', await attempt(privilege, false)]).toEqual([privilege, 'whole table', true])
        }
      } finally {
        await exec(
          [
            ...env.db.users.build({
              op: 'revokeAll',
              user,
              database: ns.database,
              ...(ns.schema ? { schema: ns.schema } : {}),
            }),
            ...env.db.users.build({ op: 'dropUser', user }),
          ]
            .map((x) => x.sql)
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })

    it('create → grant → password → revoke → drop through the builder', async () => {
      const name = `u_${scratch}`
      const user = dialect === 'mysql' ? { name, host: '%' } : { name }
      const runOp = async (op: Parameters<typeof env.db.users.build>[0]) => {
        const target = env.db.users.namespace(op, env.db.serverNamespace)
        const r = await env.db.executeSql(
          target,
          env.db.users
            .build(op)
            .map((s) => s.sql)
            .join(';\n'),
          EXEC
        )
        for (const x of r) if (x.kind === 'error') throw new Error(`${x.message}\n${x.sql}`)
      }
      await runOp({
        op: 'createUser',
        user,
        password: "s3cret'!",
        attributes: { superuser: false, createdb: false, createrole: false },
      })
      expect((await env.db.listUsers()).some((u) => u.name === name)).toBe(true)
      await runOp({ op: 'grantAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
      const grants = await env.db.showGrants(user)
      // MySQL grants are per database (printed as a LIKE pattern, `_` escaped); PostgreSQL grants are per
      // schema/table inside the current database.
      if (dialect === 'mysql') expect(grants.join('\n')).toContain(`\`${ns.database.replaceAll('_', '\\_')}\`.*`)
      else expect(grants.join('\n')).toContain(ns.schema ?? 'public')
      // MariaDB prints the password hash inside SHOW GRANTS; it never reaches the privileges screen.
      expect(grants.join('\n')).not.toMatch(/IDENTIFIED (?:BY|VIA)/i)
      if (dialect === 'postgres') {
        // Table grants are read from pg_class.relacl, so every table the role can SELECT is listed.
        expect(grants.join('\n')).toMatch(
          new RegExp(`GRANT [A-Z, ]*SELECT[A-Z, ]* ON "${ns.schema ?? 'public'}"\\."users" TO`)
        )
        // ACLs are per database: inspecting another database does not show this one's table grants.
        const elsewhere = await env.db.showGrants(user, { database: 'postgres' })
        expect(elsewhere.join('\n')).not.toContain('"users"')
        expect((await env.db.showGrants(user, ns)).join('\n')).toContain('"users"')
      }
      await runOp({ op: 'setPassword', user, password: 'changed' })
      await runOp({ op: 'revokeAll', user, database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) })
      await runOp({ op: 'dropUser', user })
      expect((await env.db.listUsers()).some((u) => u.name === name)).toBe(false)
    })
  })
}
