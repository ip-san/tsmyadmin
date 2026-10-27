/** Hands `text` to the browser as a file download (client-side data such as SQL console results). */
export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

/** Hands a Blob to the browser as a file download. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const FILENAME_LENGTH = 60
const cleanName = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '')

/**
 * Filesystem-safe name from a table / statement label. A `tail` (a part of the whole, such as a chapter) is kept
 * whole, and the label cut short before it, so that the files of two parts are never named the same.
 */
export function safeFilename(base: string, ext: string, tail?: string): string {
  const end = tail ? cleanName(tail).slice(0, FILENAME_LENGTH) : ''
  const room = end ? Math.max(0, FILENAME_LENGTH - end.length - 1) : FILENAME_LENGTH
  const head = cleanName(base).slice(0, room).replace(/_+$/, '')
  return `${[head, end].filter(Boolean).join('_') || 'result'}.${ext}`
}
