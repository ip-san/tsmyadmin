export const CODE_LANGUAGES = ['php', 'javascript', 'python', 'java'] as const
export type CodeLanguage = (typeof CODE_LANGUAGES)[number]

/**
 * The statement as a string literal of a programming language, ready to paste into an application (phpMyAdmin's
 * "Create PHP code"). Only the literal is written: how the statement is run and how values are bound is the
 * application's, so a value belongs in a placeholder rather than in this text.
 */
export function sqlToCode(language: CodeLanguage, sql: string): string {
  const text = sql.trim()
  switch (language) {
    case 'php':
      return `$sql = '${text.replace(/[\\']/g, '\\$&')}';`
    case 'javascript':
      return `const sql = \`${text.replace(/[\\`]|\$\{/g, '\\$&')}\`;`
    case 'python':
      return `sql = """${text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`
    case 'java': {
      // A text block: its content starts on the line after the opening quotes and ends at the closing ones.
      const body = text
        .replace(/\\/g, '\\\\')
        .replace(/"""/g, '\\"\\"\\"')
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
      return `String sql = """\n${body}""";`
    }
  }
}
