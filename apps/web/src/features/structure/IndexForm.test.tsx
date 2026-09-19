import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IndexForm } from './IndexForm.tsx'

describe('IndexForm', () => {
  it('keeps prefix lengths only for the chosen columns that have one', async () => {
    const onSubmit = vi.fn()
    render(
      <IndexForm
        table="t"
        dialect="mysql"
        columns={['a', 'b', 'c']}
        initial={{ columns: ['a', 'b'], lengths: { a: 5, c: 9 } }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '次へ（SQL を確認）' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({
      name: 'idx_t_a_b',
      columns: ['a', 'b'],
      unique: false,
      kind: 'index',
      lengths: { a: 5 },
    })
  })

  it('sends neither a method nor lengths for a FULLTEXT index', async () => {
    const onSubmit = vi.fn()
    render(
      <IndexForm
        table="t"
        dialect="mysql"
        columns={['a']}
        initial={{ columns: ['a'], method: 'btree', lengths: { a: 5 } }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )
    await userEvent.selectOptions(screen.getByLabelText('種類'), 'fulltext')
    expect(screen.queryByLabelText('方式')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '次へ（SQL を確認）' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'idx_t_a', columns: ['a'], unique: false, kind: 'fulltext' })
  })

  it('offers PostgreSQL its access methods and no prefix lengths', () => {
    render(
      <IndexForm
        table="t"
        dialect="postgres"
        columns={['a']}
        initial={{ columns: ['a'] }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('option', { name: 'GIN' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'FULLTEXT（全文）' })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })
})
