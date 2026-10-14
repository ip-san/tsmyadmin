import { describe, expect, it } from 'vitest'
import { enumChoices } from './enum-values.ts'

describe('enumChoices', () => {
  it('reads the values of an enum or a set, in any case, with or without space before the parenthesis', () => {
    expect(enumChoices("enum('small','medium','large')")).toEqual(['small', 'medium', 'large'])
    expect(enumChoices("SET('a','b')")).toEqual(['a', 'b'])
    expect(enumChoices("ENUM('a', 'b' ,'c')")).toEqual(['a', 'b', 'c'])
    expect(enumChoices("SET ('x')")).toEqual(['x'])
    expect(enumChoices("  enum('a')  ")).toEqual(['a'])
    expect(enumChoices("enum('a)b')")).toEqual(['a)b'])
    expect(enumChoices("enum('日本','語')")).toEqual(['日本', '語'])
    expect(enumChoices("enum('')")).toEqual([''])
  })

  it('reads doubled and escaped quotes, commas and spaces inside a value', () => {
    expect(enumChoices("enum('it''s','a,b','c d','back\\\\slash')")).toEqual(["it's", 'a,b', 'c d', 'back\\slash'])
    expect(enumChoices("enum('it\\'s')")).toEqual(["it's"])
    expect(enumChoices("enum('a''','''b')")).toEqual(["a'", "'b"])
  })

  it('is null for other types, no values, and a list it cannot read', () => {
    for (const none of [
      'varchar(20)',
      'int',
      'mood',
      'enumx',
      "xenum('a')",
      "enum('a','b",
      "enum('a'",
      "enum('a",
      'enum()',
      'enum( )',
      'enum(a)',
      "enum('a'b)",
      '',
      "enum('a\\",
    ])
      expect(enumChoices(none), none).toBeNull()
  })
})
