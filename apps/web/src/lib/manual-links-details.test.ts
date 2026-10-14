import { describe, expect, it } from 'vitest'
import { manualTopic, manualUrl } from './manual-links.ts'

describe('manualTopic', () => {
  it('drops the server- prefix only at the start of the last segment', () => {
    expect(manualTopic('/server-status')).toBe('status')
    // "server-" in the middle is not a prefix: the topic stays unknown.
    expect(manualTopic('/staserver-tus')).toBeNull()
  })
  it('reads the last segment, and ignores a trailing slash', () => {
    expect(manualTopic('/db/$db/table/$table/search/')).toBe('search')
    expect(manualTopic('/db/$db/sql')).toBe('sql')
  })
})

describe('manualUrl versions', () => {
  it('uses the leading major number for PostgreSQL, and current when there is none', () => {
    expect(manualUrl('postgres', '17.0', 'sql')).toBe('https://www.postgresql.org/docs/17/sql-commands.html')
    expect(manualUrl('postgres', '9.6.24', 'sql')).toBe('https://www.postgresql.org/docs/9/sql-commands.html')
    expect(manualUrl('postgres', 'PostgreSQL 16.2', 'sql')).toBe(
      'https://www.postgresql.org/docs/current/sql-commands.html'
    )
    expect(manualUrl('postgres', '', 'sql')).toBe('https://www.postgresql.org/docs/current/sql-commands.html')
  })
  it('uses major.minor for MySQL, and 8.4 when the version is unreadable', () => {
    expect(manualUrl('mysql', '5.7.44', 'sql')).toBe('https://dev.mysql.com/doc/refman/5.7/en/sql-statements.html')
    expect(manualUrl('mysql', '8.10.1', 'sql')).toBe('https://dev.mysql.com/doc/refman/8.10/en/sql-statements.html')
    expect(manualUrl('mysql', '10.2.0', 'sql')).toBe('https://dev.mysql.com/doc/refman/10.2/en/sql-statements.html')
    expect(manualUrl('mysql', 'v8.0', 'sql')).toBe('https://dev.mysql.com/doc/refman/8.4/en/sql-statements.html')
    expect(manualUrl('mysql', '', 'sql')).toBe('https://dev.mysql.com/doc/refman/8.4/en/sql-statements.html')
  })
})
