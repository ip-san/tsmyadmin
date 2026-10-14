import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale.ts'
import { formatDocumentTitle, useDocumentTitle } from './document-title.ts'

const app = locale.app.name
/** The title of a page: its parts, then the app name. */
const titled = (...parts: string[]) => [...parts, app].join(' – ')

describe('formatDocumentTitle', () => {
  it('drops parts that are empty or only blanks, keeping the others as given', () => {
    expect(formatDocumentTitle(['  ', 'shop', '\t'])).toBe(titled('shop'))
    expect(formatDocumentTitle(['  ', undefined])).toBe(app)
    expect(formatDocumentTitle([' a ', 'b'])).toBe(titled(' a ', 'b'))
  })
})

function Title({ parts, children }: { parts: (string | undefined)[]; children?: ReactNode }) {
  useDocumentTitle(...parts)
  return <>{children}</>
}

describe('useDocumentTitle', () => {
  it('sets the title while mounted and restores the app name after', () => {
    document.title = 'before'
    const view = render(<Title parts={['users']} />)
    expect(document.title).toBe(titled('users'))
    view.unmount()
    expect(document.title).toBe(app)
  })

  it('follows a change of the parts, without leaving the old title behind', () => {
    const view = render(<Title parts={['one']} />)
    view.rerender(<Title parts={['two']} />)
    expect(document.title).toBe(titled('two'))
    view.unmount()
    expect(document.title).toBe(app)
  })

  it('shows the innermost layout’s title, and the parent’s again when the child goes', () => {
    const tree = (child: ReactNode, parent = 'shop') => <Title parts={[parent]}>{child}</Title>
    const view = render(tree(<Title parts={['orders', 'shop']} />))
    expect(document.title).toBe(titled('orders', 'shop'))
    view.rerender(tree(null))
    expect(document.title).toBe(titled('shop'))
  })

  it('keeps the child’s title when the parent’s title changes later', () => {
    const tree = (parent: string) => (
      <Title parts={[parent]}>
        <Title parts={['child']} />
      </Title>
    )
    const view = render(tree('a'))
    expect(document.title).toBe(titled('child'))
    view.rerender(tree('b'))
    expect(document.title).toBe(titled('child'))
    view.unmount()
    expect(document.title).toBe(app)
  })

  it('removes only its own entry when one of two unmounts', () => {
    const tree = (child: boolean) => <Title parts={['parent']}>{child ? <Title parts={['child']} /> : null}</Title>
    const view = render(tree(true))
    view.rerender(tree(false))
    expect(document.title).toBe(titled('parent'))
    view.rerender(tree(true))
    expect(document.title).toBe(titled('child'))
  })
})
