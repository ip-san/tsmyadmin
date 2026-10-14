import { describe, expect, it } from 'vitest'
import { conditionText, conditionValue, valueShape } from './filter-values.ts'

describe('valueShape', () => {
  it('says what each kind of operator takes', () => {
    expect(valueShape('')).toBe('none')
    expect(valueShape('is_null')).toBe('none')
    expect(valueShape('not_empty')).toBe('none')
    expect(valueShape('in')).toBe('list')
    expect(valueShape('between')).toBe('list')
    expect(valueShape('eq')).toBe('one')
    expect(valueShape('like')).toBe('one')
  })
})

describe('conditionValue', () => {
  it('gives nothing for an operator without a value, even when text was typed', () => {
    expect(conditionValue('is_null', 'abc')).toEqual({})
  })
  it('keeps the text of a single value as it is', () => {
    expect(conditionValue('eq', ' a, b ')).toEqual({ value: ' a, b ' })
  })
  it('splits a list on commas, trims each and drops the empty ones', () => {
    expect(conditionValue('in', '1, 2 ,,3,')).toEqual({ values: ['1', '2', '3'] })
    expect(conditionValue('between', ' low ,high')).toEqual({ values: ['low', 'high'] })
    expect(conditionValue('in', '')).toEqual({ values: [] })
  })
})

describe('conditionText', () => {
  it('joins a list with comma and space, showing null as empty', () => {
    expect(conditionText({ values: ['a', null, 3] })).toBe('a, , 3')
    expect(conditionText({ values: [] })).toBe('')
  })
  it('shows a single value as text, and nothing as empty', () => {
    expect(conditionText({ value: 5 })).toBe('5')
    expect(conditionText({ value: 0 })).toBe('0')
    expect(conditionText({ value: false })).toBe('false')
    expect(conditionText({ value: null })).toBe('')
    expect(conditionText({})).toBe('')
  })
  it('prefers the list over the value', () => {
    expect(conditionText({ value: 'x', values: ['1', '2'] })).toBe('1, 2')
  })
})
