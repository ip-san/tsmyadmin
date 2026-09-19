/**
 * A standalone SVG document as a PNG, drawn by the browser at `factor` times its size (sharp on a dense screen and
 * in print). Nothing leaves the browser: the SVG is read from a `data:` URL (the page's CSP allows images from
 * `self` and `data:`, not `blob:`), and the canvas is never tainted because the document holds no outside references.
 */
export async function svgToPng(svg: string, width: number, height: number, factor = 2): Promise<Blob> {
  const image = new Image()
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The picture could not be drawn'))
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * factor)
  canvas.height = Math.round(height * factor)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The picture could not be drawn')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be drawn'))), 'image/png')
  )
}
