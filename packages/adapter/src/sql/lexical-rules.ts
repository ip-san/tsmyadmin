import { capabilities, type Dialect } from '@tsmyadmin/shared'

/**
 * How each server reads SQL text, as facts the scanner reads (see `split.ts`): which spans are literals or comments,
 * and which client commands sit between statements. Every consumer of SQL text — the splitter, comment stripping, the
 * audit log's redaction — shares them, so a difference between the servers is written here once.
 */
export interface LexicalRules {
  /** `name` in backticks is an identifier (MySQL). */
  backtickIdentifiers: boolean
  /** A backslash inside '…' escapes the next character (MySQL, unless NO_BACKSLASH_ESCAPES is on). */
  backslashEscapes: boolean
  /** `E'…'` is a string with backslash escapes (PostgreSQL). */
  escapeStrings: boolean
  /** `$tag$…$tag$` is a literal (PostgreSQL). */
  dollarQuotes: boolean
  /** `/* … /* … *\/ … *\/` nests (PostgreSQL); on MySQL the first `*\/` ends it. */
  nestedBlockComments: boolean
  /** `/*!40101 … *\/` is code the server runs, not a comment (MySQL). */
  versionComments: boolean
  /** `# …` runs to the end of the line (MySQL). */
  hashComments: boolean
  /** `--` starts a comment only before whitespace: `2--2` is arithmetic (MySQL). */
  dashCommentNeedsSpace: boolean
  /** `DELIMITER //` is a client command that changes what ends a statement (MySQL). */
  delimiterCommand: boolean
  /** `SET sql_mode` can turn NO_BACKSLASH_ESCAPES on, which changes how the rest of the script is read (MySQL). */
  tracksSqlMode: boolean
  /** `COPY … FROM stdin` is followed by the rows, up to `\.` (PostgreSQL). */
  copyFromStdin: boolean
  /** A line starting with a backslash between statements is a psql meta-command: `\connect`, `\restrict` (PostgreSQL). */
  psqlMetaCommands: boolean
  /** `BEGIN ATOMIC … END` is a routine body whose semicolons do not end the statement (PostgreSQL). */
  beginAtomic: boolean
}

const RULES: Record<Dialect, Omit<LexicalRules, 'backslashEscapes'>> = {
  mysql: {
    backtickIdentifiers: true,
    escapeStrings: false,
    dollarQuotes: false,
    nestedBlockComments: false,
    versionComments: true,
    hashComments: true,
    dashCommentNeedsSpace: true,
    delimiterCommand: true,
    tracksSqlMode: true,
    copyFromStdin: false,
    psqlMetaCommands: false,
    beginAtomic: false,
  },
  postgres: {
    backtickIdentifiers: false,
    escapeStrings: true,
    dollarQuotes: true,
    nestedBlockComments: true,
    versionComments: false,
    hashComments: false,
    dashCommentNeedsSpace: false,
    delimiterCommand: false,
    tracksSqlMode: false,
    copyFromStdin: true,
    psqlMetaCommands: true,
    beginAtomic: true,
  },
}

export function lexicalRules(dialect: Dialect): LexicalRules {
  return { ...RULES[dialect], backslashEscapes: capabilities(dialect).literalBackslashEscapes }
}
