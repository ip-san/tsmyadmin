import type { Dialect } from './schemas/dialect.ts'

/** Delimiters tried in turn for MySQL scripts: the first one no statement contains is used. */
const DELIMITERS = ['$$', '//', ';;', '$$$$']

/**
 * Generated statements as one script the SQL route splits back into exactly those statements. A MySQL routine,
 * trigger or event body holds `;` of its own, so there the script switches delimiter with `DELIMITER` lines, as
 * the mysql client does; PostgreSQL bodies are dollar-quoted, which the splitter already reads as one string.
 */
export function sqlScript(dialect: Dialect, statements: readonly string[]): string {
  if (dialect === 'postgres' || !statements.some((s) => s.includes(';'))) return statements.join(';\n')
  const delimiter = DELIMITERS.find((d) => !statements.some((s) => s.includes(d)))
  if (!delimiter) throw new Error('No delimiter is free of the statements')
  return `DELIMITER ${delimiter}\n${statements.map((s) => `${s}${delimiter}`).join('\n')}\nDELIMITER ;`
}
