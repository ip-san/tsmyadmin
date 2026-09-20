/**
 * The values a MySQL `enum('a','b')` or `set('a','b')` column holds, from its type as the catalog prints it; null for
 * any other type. A quote inside a value is doubled (`'it''s'`) or backslash-escaped, as SHOW COLUMNS prints it.
 */
export function enumChoices(dataType: string): string[] | null {
  const m = /^(?:enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(dataType.trim())
  if (!m) return null
  const inner = m[1] as string
  const out: string[] = []
  let i = 0
  while (i < inner.length) {
    if (inner[i] === ',' || inner[i] === ' ') {
      i++
      continue
    }
    if (inner[i] !== "'") return null
    let value = ''
    i++
    for (;;) {
      const ch = inner[i]
      if (ch === undefined) return null
      if (ch === '\\' && i + 1 < inner.length) {
        value += inner[i + 1]
        i += 2
      } else if (ch === "'" && inner[i + 1] === "'") {
        value += "'"
        i += 2
      } else if (ch === "'") {
        i++
        break
      } else {
        value += ch
        i++
      }
    }
    out.push(value)
  }
  return out.length > 0 ? out : null
}
