import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './Pagination.tsx'

describe('Pagination', () => {
  it('shows totals and range and disables navigation at the edges', () => {
    render(<Pagination page={1} limit={50} total={120} shown={50} onChange={vi.fn()} />)
    expect(screen.getByText(/全 120 行/)).toBeInTheDocument()
    expect(screen.getByText(/1–50 行目/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })

  it('emits page and limit changes (limit resets to page 1)', async () => {
    const onChange = vi.fn()
    render(<Pagination page={2} limit={50} total={120} shown={50} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: '次へ' }))
    expect(onChange).toHaveBeenCalledWith({ page: 3 })
    await userEvent.click(screen.getByRole('button', { name: '最後のページ' }))
    expect(onChange).toHaveBeenCalledWith({ page: 3 })
    await userEvent.selectOptions(screen.getByLabelText('表示件数'), '100')
    expect(onChange).toHaveBeenCalledWith({ limit: 100, page: 1 })
  })

  it('falls back to "has next when page is full" when total is unknown', () => {
    render(<Pagination page={1} limit={50} total={null} shown={50} onChange={vi.fn()} />)
    expect(screen.getByText(/行数不明/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '最後のページ' })).toBeDisabled()
  })
})

describe('Pagination (approximate totals)', () => {
  it('labels catalog estimates as approximate', () => {
    render(<Pagination page={1} limit={50} total={1234567} approximate shown={50} onChange={vi.fn()} />)
    expect(screen.getByText(/約 1,234,567 行（概算）/)).toBeInTheDocument()
  })
})
