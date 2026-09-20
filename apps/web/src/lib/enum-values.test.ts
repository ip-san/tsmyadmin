import { describe, expect, it } from 'vitest'
import { enumChoices } from './enum-values.ts'

describe('enumChoices', () => {
  it('reads the values of an enum or a set', () => {
    expect(enumChoices("enum('small','medium','large')")).toEqual(['small', 'medium', 'large'])
    expect(enumChoices("SET('a','b')")).toEqual(['a', 'b'])
  })

  it('reads doubled and escaped quotes, commas and spaces inside a value', () => {
    expect(enumChoices("enum('it''s','a,b','c d','back\\\\slash')")).toEqual(["it's", 'a,b', 'c d', 'back\\slash'])
  })

  it('is null for other types and for a list it cannot read', () => {
    expect(enumChoices('varchar(20)')).toBeNull()
    expect(enumChoices('mood')).toBeNull()
    expect(enumChoices("enum('a','b")).toBeNull()
    expect(enumChoices('enum()')).toBeNull()
  })
})
