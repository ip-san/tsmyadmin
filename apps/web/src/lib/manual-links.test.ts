import { describe, expect, it } from 'vitest'
import { manualTopic, manualUrl } from './manual-links.ts'

describe('manualTopic', () => {
  it('reads the topic from the tab route', () => {
    expect(manualTopic('/')).toBe('databases')
    expect(manualTopic('/db/$db')).toBe('structure')
    expect(manualTopic('/db/$db/')).toBe('structure')
    expect(manualTopic('/db/$db/table/$table')).toBe('browse')
    expect(manualTopic('/db/$db/table/$table/insert')).toBe('insert')
    expect(manualTopic('/server-export')).toBe('export')
    expect(manualTopic('/settings')).toBeNull()
  })
})

describe('manualUrl', () => {
  it('points at the vendor manual for the server version', () => {
    expect(manualUrl('mysql', '8.0.36', 'sql')).toBe('https://dev.mysql.com/doc/refman/8.0/en/sql-statements.html')
    expect(manualUrl('postgres', '16.2', 'insert')).toBe('https://www.postgresql.org/docs/16/sql-insert.html')
  })
  it('has no page for what the server does not have, or does not know', () => {
    expect(manualUrl('postgres', '16.2', 'events')).toBeNull()
    expect(manualUrl('mysql', '8.0', 'nope')).toBeNull()
  })
  it('sends MariaDB to its own documentation', () => {
    expect(manualUrl('mysql', '11.4.2-MariaDB', 'sql')).toMatch(/^https:\/\/mariadb\.com\//)
  })
})
