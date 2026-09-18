/** Modules of quiet zone around the symbol, as the QR specification asks for. */
const QUIET = 4

/**
 * A QR code from rows of '1' / '0' as one SVG path. Always dark on white, whatever the theme: scanners read it
 * that way round, so the colours are fixed rather than themed.
 */
export function QrCode({ rows, label }: { rows: readonly string[]; label: string }) {
  const size = rows.length
  let d = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x} ${y}h1v1h-1z`
  })
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET} ${-QUIET} ${size + QUIET * 2} ${size + QUIET * 2}`}
      className="size-48"
      shapeRendering="crispEdges"
    >
      <rect x={-QUIET} y={-QUIET} width={size + QUIET * 2} height={size + QUIET * 2} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
