/** `'app'` / `\`app\`` as SHOW GRANTS prints them, back to the bare name. */
function unquote(part: string): string {
  const q = part[0]
  return part.length >= 2 && (q === "'" || q === '`' || q === '"') && part.endsWith(q)
    ? part.slice(1, -1).replaceAll(q + q, q)
    : part
}

/**
 * A DEFINER as typed: `user@host`, split at the last `@` (a user name may itself hold one). Empty is no DEFINER;
 * `'invalid'` is something typed that has no host.
 */
export function parseDefiner(text: string): { user: string; host: string } | null | 'invalid' {
  const value = text.trim()
  if (value === '') return null
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return 'invalid'
  const user = unquote(value.slice(0, at))
  return user === '' ? 'invalid' : { user, host: unquote(value.slice(at + 1)) }
}
