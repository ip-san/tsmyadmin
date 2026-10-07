import { describe, expect, it } from 'vitest'
import { isGeneratedColumn, onUpdateExpression } from './structure.ts'

describe('isGeneratedColumn', () => {
  it.each(['VIRTUAL GENERATED', 'STORED GENERATED', 'generated stored', 'GENERATED'])(
    'is true for %s: the server computes it',
    (extra) => {
      expect(isGeneratedColumn(extra)).toBe(true)
    }
  )

  it.each([
    '',
    'auto_increment',
    'DEFAULT_GENERATED',
    'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
    'identity always',
    'serial',
  ])('is false for %j: an ordinary column, an expression default or an identity column', (extra) => {
    expect(isGeneratedColumn(extra)).toBe(false)
  })
})

describe('onUpdateExpression', () => {
  it('reads the clause MySQL prints in extra, with its precision, in upper case', () => {
    expect(onUpdateExpression('DEFAULT_GENERATED on update CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(onUpdateExpression('on update current_timestamp(3)')).toBe('CURRENT_TIMESTAMP(3)')
  })

  it('is null when there is no such clause', () => {
    expect(onUpdateExpression('')).toBeNull()
    expect(onUpdateExpression('auto_increment')).toBeNull()
    expect(onUpdateExpression('on update something_else')).toBeNull()
  })
})
