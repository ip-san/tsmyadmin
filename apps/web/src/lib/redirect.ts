/**
 * Post-login destination taken from the `?redirect=` search param. Only same-origin paths are accepted; absolute
 * URLs, protocol-relative `//host` and anything else fall back to the top page (open-redirect guard).
 */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/'
  // A login loop would otherwise send the user straight back to /login after authenticating.
  if (target === '/login' || target.startsWith('/login?')) return '/'
  return target
}
