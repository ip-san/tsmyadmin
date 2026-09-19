import { describe, expect, it } from 'vitest'
import { describeOptions, EMPTY_PARAMS, transformOptions } from './transform-params.ts'

const p = (over: Partial<typeof EMPTY_PARAMS>) => ({ ...EMPTY_PARAMS, ...over })

describe('transformOptions', () => {
  it('keeps only the fields the kind uses', () => {
    expect(transformOptions('substring', p({ start: '2', length: '5', prefix: 'x' }))).toEqual({ start: 2, length: 5 })
    expect(transformOptions('link', p({ template: ' https://x/{value} ' }))).toEqual({ template: 'https://x/{value}' })
    expect(transformOptions('link', p({}))).toEqual({})
    expect(transformOptions('boolean', p({ trueText: 'ON' }))).toEqual({ trueText: 'ON' })
    expect(transformOptions('date', p({ format: ' YYYY ' }))).toEqual({ format: 'YYYY' })
    expect(transformOptions('pattern', p({ pattern: '^a', message: 'no' }))).toEqual({ pattern: '^a', message: 'no' })
    expect(transformOptions('hex', p({ start: '3' }))).toEqual({})
  })

  it('corrects a length that is not a positive whole number, and keeps spaces in an affix', () => {
    expect(transformOptions('substring', p({ start: '-4', length: '0' }))).toEqual({ start: 0, length: 1 })
    expect(transformOptions('substring', p({ start: 'x', length: '' }))).toEqual({ start: 0, length: 1 })
    expect(transformOptions('affix', p({ prefix: '', suffix: ' 円' }))).toEqual({ suffix: ' 円' })
  })
})

describe('describeOptions', () => {
  it('says how each kind is set', () => {
    const base = { database: 'd', table: 't', column: 'c' }
    expect(describeOptions({ ...base, kind: 'substring', start: 1, length: 3 })).toBe('1+3')
    expect(describeOptions({ ...base, kind: 'affix', prefix: '¥' })).toBe('¥…')
    expect(describeOptions({ ...base, kind: 'hex' })).toBe('')
  })
})
