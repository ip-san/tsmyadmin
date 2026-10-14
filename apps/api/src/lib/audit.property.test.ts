import { connectionStatement, credentialScript, SECRET_MARK } from '@tsmyadmin/shared/testing'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { summarise } from './audit.ts'

/**
 * Properties of the audit log's SQL summary: a script holding a password in any credential position, written the way
 * the server reads it (or left unterminated), with statements around it that carry quotes, comments and `;` inside
 * literals, never logs any fragment of the password.
 */

const ns = { database: 'shop' }
const params = { seed: 20261014, numRuns: 1500 }

describe('summarise executeSql (properties)', () => {
  for (const dialect of ['mysql', 'postgres'] as const) {
    const logged = (sql: string) => String(summarise('executeSql', [ns, sql], dialect).sql)

    it(`logs no fragment of a password in any credential position (${dialect})`, () => {
      fc.assert(
        fc.property(credentialScript(dialect), ({ sql }) => {
          expect(logged(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })

    it(`logs no password of a connection string or URL (${dialect})`, () => {
      fc.assert(
        fc.property(credentialScript(dialect, connectionStatement(dialect)), ({ sql }) => {
          expect(logged(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })
  }
})
