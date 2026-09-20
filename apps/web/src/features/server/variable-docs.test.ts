import { describe, expect, it } from 'vitest'
import { variableDocUrl } from './variable-docs.ts'

describe('variableDocUrl', () => {
  it('points MySQL variables at the page of their group, for the server’s own release', () => {
    expect(variableDocUrl('mysql', '8.0.36', 'max_connections')).toBe(
      'https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html#sysvar_max_connections'
    )
    expect(variableDocUrl('mysql', '8.4.2', 'innodb_buffer_pool_size')).toBe(
      'https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html#sysvar_innodb_buffer_pool_size'
    )
    expect(variableDocUrl('mysql', '8.4.2', 'gtid_mode')).toContain('replication-options-gtids.html#sysvar_gtid_mode')
    expect(variableDocUrl('mysql', '8.4.2', 'server_id')).toContain('replication-options-binary-log.html')
  })

  it('uses the MariaDB knowledge base when the version says MariaDB', () => {
    expect(variableDocUrl('mysql', '11.4.2-MariaDB-ubu2404', 'max_connections')).toBe(
      'https://mariadb.com/kb/en/server-system-variables/#max_connections'
    )
    expect(variableDocUrl('mysql', '10.11.9-MariaDB', 'innodb_log_file_size')).toContain('innodb-system-variables')
  })

  it('searches the PostgreSQL manual of the server’s major version', () => {
    expect(variableDocUrl('postgres', '17.2 (Debian)', 'work_mem')).toBe(
      'https://www.postgresql.org/search/?u=%2Fdocs%2F17%2F&q=work_mem'
    )
    expect(variableDocUrl('postgres', '', 'work_mem')).toContain('%2Fdocs%2Fcurrent%2F')
  })

  it('makes no link from a name that is not a plain variable name', () => {
    expect(variableDocUrl('mysql', '8.4.0', 'a b')).toBeNull()
    expect(variableDocUrl('mysql', '8.4.0', 'x#y')).toBeNull()
    expect(variableDocUrl('postgres', '17', 'a&b=c')).toBeNull()
  })
})
