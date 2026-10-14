import { connectionStatement, credentialScript, SECRET_MARK } from '@tsmyadmin/shared/testing'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { maskSql } from './debug-sql.ts'

/**
 * Properties of the debug panel's masking, which does not know the dialect and does not split statements: a script of
 * either server with a password in any credential position (closed or not, among statements that carry quotes,
 * comments and `;` inside literals) shows no fragment of the password.
 */

const params = { seed: 20261014, numRuns: 1500 }

describe('maskSql (properties)', () => {
  for (const dialect of ['mysql', 'postgres'] as const) {
    it(`shows no fragment of a password in any credential position (${dialect})`, () => {
      fc.assert(
        fc.property(credentialScript(dialect), ({ sql }) => {
          expect(maskSql(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })

    it(`shows no password of a connection string or URL (${dialect})`, () => {
      fc.assert(
        fc.property(credentialScript(dialect, connectionStatement(dialect)), ({ sql }) => {
          expect(maskSql(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })
  }
})
