import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { formatDocumentTitle, useDocumentTitle } from './document-title.ts'

describe('formatDocumentTitle', () => {
  it('drops parts that are empty or only blanks, keeping the others as given', () => {
    expect(formatDocumentTitle(['  ', 'shop', '\t'])).toBe('shop – tsmyadmin')
    expect(formatDocumentTitle(['  ', undefined])).toBe('tsmyadmin')
    expect(formatDocumentTitle([' a ', 'b'])).toBe(' a  – b – tsmyadmin')
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
    expect(document.title).toBe('users – tsmyadmin')
    view.unmount()
    expect(document.title).toBe('tsmyadmin')
  })

  it('follows a change of the parts, without leaving the old title behind', () => {
    const view = render(<Title parts={['one']} />)
    view.rerender(<Title parts={['two']} />)
    expect(document.title).toBe('two – tsmyadmin')
    view.unmount()
    expect(document.title).toBe('tsmyadmin')
  })

  it('shows the innermost layout’s title, and the parent’s again when the child goes', () => {
    const tree = (child: ReactNode, parent = 'shop') => <Title parts={[parent]}>{child}</Title>
    const view = render(tree(<Title parts={['orders', 'shop']} />))
    expect(document.title).toBe('orders – shop – tsmyadmin')
    view.rerender(tree(null))
    expect(document.title).toBe('shop – tsmyadmin')
  })

  it('keeps the child’s title when the parent’s title changes later', () => {
    const tree = (parent: string) => (
      <Title parts={[parent]}>
        <Title parts={['child']} />
      </Title>
    )
    const view = render(tree('a'))
    expect(document.title).toBe('child – tsmyadmin')
    view.rerender(tree('b'))
    expect(document.title).toBe('child – tsmyadmin')
    view.unmount()
    expect(document.title).toBe('tsmyadmin')
  })

  it('removes only its own entry when one of two unmounts', () => {
    const tree = (child: boolean) => <Title parts={['parent']}>{child ? <Title parts={['child']} /> : null}</Title>
    const view = render(tree(true))
    view.rerender(tree(false))
    expect(document.title).toBe('parent – tsmyadmin')
    view.rerender(tree(true))
    expect(document.title).toBe('child – tsmyadmin')
  })

  it('lets the one rendered later win among siblings', () => {
    const view = render(
      <>
        <Title parts={['first']} />
        <Title parts={['second']} />
      </>
    )
    expect(document.title).toBe('second – tsmyadmin')
    view.unmount()
    expect(document.title).toBe('tsmyadmin')
  })
})
