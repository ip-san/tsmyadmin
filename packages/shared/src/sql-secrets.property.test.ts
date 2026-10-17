import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { maskConnectionPassword, maskCredentialPart } from './sql-secrets.ts'
import { connectionStatement, credentialStatement, SECRET_MARK } from './testing/credential-sql.ts'

/**
 * Properties of the masking rule both the audit log and the debug panel use: whatever the password holds and however
 * its literal is written (or left open), no fragment of it is left in the masked statement.
 */

/** As the debug panel composes them (the audit log strips comments, then runs the connection rule first). */
const mask = (sql: string) => maskConnectionPassword(maskCredentialPart(sql))
const params = { seed: 20261014, numRuns: 2000 }

describe('maskCredentialPart (properties)', () => {
  for (const dialect of ['mysql', 'postgres'] as const) {
    it(`leaves no fragment of a password in any credential position (${dialect})`, () => {
      fc.assert(
        fc.property(credentialStatement(dialect), ({ sql }) => {
          expect(mask(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })

    it(`leaves no password of a connection string or URL (${dialect})`, () => {
      fc.assert(
        fc.property(connectionStatement(dialect), ({ sql }) => {
          expect(mask(sql)).not.toContain(SECRET_MARK)
        }),
        params
      )
    })
  }

  it('keeps the statement up to the credential keyword', () => {
    fc.assert(
      fc.property(fc.oneof(credentialStatement('mysql'), credentialStatement('postgres')), ({ sql }) => {
        const head = /^[\s\S]*?\b(?:\w+_)?(?:IDENTIFIED|PASSWORD)\b/i.exec(sql)?.[0] ?? ''
        expect(mask(sql).startsWith(head)).toBe(true)
      }),
      params
    )
  })

  it('never changes a statement without a credential keyword or a connection password', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (sql) => {
        fc.pre(!/IDENTIFIED|PASSWORD/i.test(sql))
        expect(mask(sql)).toBe(sql)
      }),
      params
    )
  })
})
