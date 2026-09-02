/** Hands `text` to the browser as a file download (client-side data such as SQL console results). */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Filesystem-safe name from a table / statement label. */
export function safeFilename(base: string, ext: string): string {
  const cleaned = base.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'result'
  return `${cleaned.slice(0, 60)}.${ext}`
}
