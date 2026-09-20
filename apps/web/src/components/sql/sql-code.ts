export const CODE_LANGUAGES = ['php', 'javascript', 'python', 'java'] as const
export type CodeLanguage = (typeof CODE_LANGUAGES)[number]

/**
 * The statement as a string literal of a programming language, ready to paste into an application (phpMyAdmin's
 * "Create PHP code"). Only the literal is written: how the statement is run and how values are bound is the
 * application's, so a value belongs in a placeholder rather than in this text.
 */
/** Text for inside """ … """ (Python, Java): backslashes doubled, and no run of three quotes, or a quote at the end that would join the closing ones. */
function tripleQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"').replace(/"$/, '\\"')
}

export function sqlToCode(language: CodeLanguage, sql: string): string {
  const text = sql.trim()
  switch (language) {
    case 'php':
      return `$sql = '${text.replace(/[\\']/g, '\\$&')}';`
    case 'javascript':
      return `const sql = \`${text.replace(/[\\`]|\$\{/g, '\\$&')}\`;`
    case 'python':
      return `sql = """${tripleQuoted(text)}"""`
    case 'java': {
      // A text block: its content starts on the line after the opening quotes and ends at the closing ones.
      const body = tripleQuoted(text)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
      return `String sql = """\n${body}""";`
    }
  }
}
