import { render, screen } from '@testing-library/react'
import type { ColumnTransform } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { imageType, TransformedCell } from './TransformedCell.tsx'

const fromBytes = (bytes: number[]) => btoa(String.fromCharCode(...bytes))
const fromText = (text: string) => btoa(text)
const ZERO4 = String.fromCharCode(0, 0, 0, 0)
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const base = { database: 'd', table: 't', column: 'c', id: '', at: 0 }

describe('imageType', () => {
  it('tells an image by its first bytes, and never takes SVG', () => {
    expect(imageType(fromBytes([...PNG, 0, 0, 0, 0]))).toBe('image/png')
    expect(imageType(fromBytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageType(fromText('GIF89a......'))).toBe('image/gif')
    expect(imageType(fromText(`RIFF${ZERO4}WEBPVP8 `))).toBe('image/webp')
    expect(imageType(fromText(`RIFF${ZERO4}WAVEfmt `))).toBeNull()
    expect(imageType(fromText('<svg xmlns="http://www.w3.org/2000/svg" onload="x()">'))).toBeNull()
    expect(imageType('%%%')).toBeNull()
  })
})

describe('TransformedCell', () => {
  it('links only to http(s), opening in a new tab without the opener', () => {
    const link: ColumnTransform = { ...base, kind: 'link', template: 'https://shop.example/items/{value}' }
    render(<TransformedCell cell="a b" transform={link} />)
    const a = screen.getByRole('link')
    expect(a.getAttribute('href')).toBe('https://shop.example/items/a%20b')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('shows a value that is not a safe link as plain text', () => {
    render(<TransformedCell cell="javascript:alert(1)" transform={{ ...base, kind: 'link' }} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy()
  })

  it('indents JSON, and leaves text that is not JSON alone', () => {
    const { container, rerender } = render(<TransformedCell cell='{"a":1}' transform={{ ...base, kind: 'json' }} />)
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "a": 1\n}')
    rerender(<TransformedCell cell="not json" transform={{ ...base, kind: 'json' }} />)
    expect(container.querySelector('pre')).toBeNull()
  })

  it('draws a binary image as a data URL, and anything else as the binary summary', () => {
    const png = fromBytes([...PNG, 1, 2, 3])
    const { container, rerender } = render(
      <TransformedCell cell={{ $bin: png }} transform={{ ...base, kind: 'image' }} />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
    rerender(<TransformedCell cell={{ $bin: fromText('<svg/>') }} transform={{ ...base, kind: 'image' }} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
