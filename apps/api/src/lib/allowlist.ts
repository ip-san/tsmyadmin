/**
 * Decides whether the login form may connect to `host:port`.
 * Entries: exact host name / IP, `*.suffix` (any subdomain of suffix), or `*` (anything); each optionally followed
 * by `:port` (`db.internal:5432`, `[::1]:3306`, `*.rds.amazonaws.com:5432`). An entry without a port allows
 * every port on that host — list ports in production so the login endpoint cannot be used to probe other
 * services on an allowed host. Matching is case-insensitive; a trailing dot and IPv6 brackets are ignored.
 */
export function isHostAllowed(host: string, port: number, allowlist: readonly string[]): boolean {
  const h = normalise(host)
  if (h === '') return false
  return allowlist.some((raw) => {
    const entry = parseEntry(raw)
    if (entry.port !== null && entry.port !== port) return false
    const e = entry.host
    if (e === '*') return true
    if (e.startsWith('*.')) {
      const suffix = e.slice(1) // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length
    }
    return e === h
  })
}

/** Allowlist entry for a preset: exactly its host:port (IPv6 literals bracketed so the port parses). */
export function presetEntry(preset: { host: string; port: number }): string {
  return preset.host.includes(':') ? `[${preset.host}]:${preset.port}` : `${preset.host}:${preset.port}`
}

/**
 * Entries that can never match a login target: a non-numeric or out-of-range port (`db:abc`, `db:5432:x`), or an
 * unbracketed IPv6 literal (`::1:5432`) — typos that would otherwise become unmatchable host names.
 */
export function invalidEntries(allowlist: readonly string[]): string[] {
  return allowlist.filter((raw) => {
    const s = raw.trim()
    if (!s.includes(':')) return false
    const m = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(s)
    if (!m) return true
    if (m[2] === undefined) return false
    const port = Number(m[2])
    return port < 1 || port > 65535
  })
}

/** Entries that allow any port (worth a warning in production). */
export function entriesWithoutPort(allowlist: readonly string[]): string[] {
  return allowlist.filter((e) => parseEntry(e).port === null)
}

/** Splits `host[:port]`; IPv6 must be bracketed (`[::1]:5432`) to carry a port. */
export function parseEntry(raw: string): { host: string; port: number | null } {
  const s = raw.trim()
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(s)
  if (m?.[1] && m[2]) {
    const port = Number(m[2])
    if (port >= 1 && port <= 65535) return { host: normalise(m[1]), port }
  }
  return { host: normalise(s), port: null }
}

/**
 * The form of a host the allowlist compares. The session connects to this, not to what was typed: otherwise the
 * check and the connection would run on different strings (` 127.0.0.1` and `127.0.0.1.` pass as `127.0.0.1`).
 */
export function normaliseHost(s: string): string {
  return normalise(s)
}

function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1')
}
