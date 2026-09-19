import { describe, expect, it } from 'vitest'
import { CODE_LANGUAGES, sqlToCode } from './sql-code.ts'

const nasty = 'SELECT \'a\\b\', "c", `d`, ${x}, """ FROM t\nWHERE x = \'$y\''

describe('sqlToCode', () => {
  it('escapes what would end or change the literal, per language', () => {
    expect(sqlToCode('php', nasty)).toBe(
      `$sql = 'SELECT \\'a\\\\b\\', "c", \`d\`, \${x}, """ FROM t\nWHERE x = \\'$y\\'';`
    )
    expect(sqlToCode('javascript', nasty)).toContain('\\`d\\`, \\${x}')
    expect(sqlToCode('javascript', nasty)).toContain("'a\\\\b'")
    expect(sqlToCode('python', nasty)).toContain('\\"\\"\\"')
    expect(sqlToCode('python', nasty)).toContain("'a\\\\b'")
    expect(sqlToCode('java', nasty)).toContain('\\"\\"\\"')
  })

  it('keeps the statement on its lines, and writes a Java text block', () => {
    expect(sqlToCode('java', 'SELECT 1\nFROM t')).toBe('String sql = """\n    SELECT 1\n    FROM t""";')
    expect(sqlToCode('python', '  SELECT 1 ')).toBe('sql = """SELECT 1"""')
    for (const language of CODE_LANGUAGES) expect(sqlToCode(language, 'SELECT 1')).toContain('SELECT 1')
  })
})
