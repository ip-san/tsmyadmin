/**
 * Decides whether the login form may connect to `host`.
 * Entries: exact host name / IP, `*.suffix` (any subdomain of suffix), or `*` (anything).
 * Matching is case-insensitive; a trailing dot and IPv6 brackets are ignored.
 */
export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalise(host)
  if (h === '') return false
  return allowlist.some((entry) => {
    const e = normalise(entry)
    if (e === '*') return true
    if (e.startsWith('*.')) {
      const suffix = e.slice(1) // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length
    }
    return e === h
  })
}

function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1')
}
