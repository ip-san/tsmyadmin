/** What a bookmarked statement may name with `[NAME]`: the place it is loaded into (phpMyAdmin's bookmark variables). */
export interface BookmarkContext {
  db: string
  schema?: string | undefined
  user: string
  host: string
}

/**
 * `[DB]`, `[SCHEMA]`, `[USER]` and `[HOST]` replaced by where the statement is loaded, so one bookmark serves every
 * database. Written into the text as it is (the user reads the statement before running it); a name it does not
 * know, and `[DB]`-like text inside a longer word, are left alone.
 */
export function expandVariables(sql: string, context: BookmarkContext): string {
  const values: Record<string, string | undefined> = {
    DB: context.db,
    SCHEMA: context.schema,
    USER: context.user,
    HOST: context.host,
  }
  return sql.replace(/\[(DB|SCHEMA|USER|HOST)\]/g, (whole, name: string) => values[name] ?? whole)
}
