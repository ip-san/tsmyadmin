/**
 * A DEFINER as typed: `user@host`, split at the last `@` (a user name may itself hold one). Empty is no DEFINER;
 * `'invalid'` is something typed that has no host.
 */
export function parseDefiner(text: string): { user: string; host: string } | null | 'invalid' {
  const value = text.trim()
  if (value === '') return null
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return 'invalid'
  return { user: value.slice(0, at), host: value.slice(at + 1) }
}
