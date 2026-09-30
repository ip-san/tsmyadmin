/**
 * The body of a saved item (a query, a template, a tracked version…) is JSON text the browser once wrote to the
 * store. One that no longer parses (an older shape, a hand edit) reads as `null`, so the caller's schema check
 * turns it down and the item is skipped instead of failing the whole list.
 */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
