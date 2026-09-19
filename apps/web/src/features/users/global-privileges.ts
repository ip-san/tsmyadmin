import { GLOBAL_PRIVILEGES, type GlobalPrivilege } from '@tsmyadmin/shared'

/**
 * The global privileges an account holds, read from its SHOW GRANTS lines: the `GRANT … ON *.* TO …` ones, with
 * `ALL PRIVILEGES` meaning every privilege but GRANT OPTION (which a trailing `WITH GRANT OPTION` gives). Names this
 * screen does not list (MySQL 8's dynamic privileges) are left out rather than guessed at.
 */
export function heldGlobalPrivileges(statements: readonly string[]): Set<GlobalPrivilege> {
  const held = new Set<GlobalPrivilege>()
  for (const statement of statements) {
    const m = /^GRANT (.+?) ON \*\.\* TO /.exec(statement)
    if (!m?.[1]) continue
    for (const name of m[1].split(',').map((p) => p.trim().toUpperCase())) {
      if (name === 'ALL PRIVILEGES' || name === 'ALL') {
        for (const p of GLOBAL_PRIVILEGES) if (p !== 'GRANT OPTION') held.add(p)
      } else {
        const known = GLOBAL_PRIVILEGES.find((p) => p === name)
        if (known) held.add(known)
      }
    }
    if (/ WITH GRANT OPTION\s*$/.test(statement)) held.add('GRANT OPTION')
  }
  return held
}

/** What has to be granted and revoked to turn `before` into `after`. */
export function globalPrivilegeChange(
  before: ReadonlySet<GlobalPrivilege>,
  after: ReadonlySet<GlobalPrivilege>
): { grant: GlobalPrivilege[]; revoke: GlobalPrivilege[] } {
  return {
    grant: GLOBAL_PRIVILEGES.filter((p) => after.has(p) && !before.has(p)),
    revoke: GLOBAL_PRIVILEGES.filter((p) => before.has(p) && !after.has(p)),
  }
}
