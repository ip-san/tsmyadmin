import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { RowForm } from './RowForm.tsx'

const col = (name: string, over: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  dataType: 'varchar(50)',
  nullable: true,
  default: null,
  extra: '',
  comment: null,
  collation: null,
  ...over,
})

const columns = [
  col('id', { dataType: 'int', nullable: false, extra: 'auto_increment' }),
  col('name', { nullable: false }),
  col('note'),
]

describe('RowForm (insert)', () => {
  it('omits default/auto-increment columns, sends NULL for nullable ones and text for the rest', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" onSubmit={onSubmit} />)
    expect(screen.getByLabelText('id: 既定値を使う')).toBeChecked()
    expect(screen.getByLabelText('note: NULL')).toBeChecked()
    await userEvent.type(screen.getByLabelText('name'), 'Zed')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Zed', note: null }, { another: false })
  })

  it('unchecking NULL enables the input and submits its text', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" onSubmit={onSubmit} />)
    await userEvent.click(screen.getByLabelText('note: NULL'))
    await userEvent.type(screen.getByLabelText('note'), 'hi')
    await userEvent.type(screen.getByLabelText('name'), 'A')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'A', note: 'hi' }, { another: false })
  })
})

describe('RowForm (edit)', () => {
  it('submits only changed columns and can set NULL', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="edit" initial={{ id: 7, name: 'Old', note: 'n' }} onSubmit={onSubmit} />)
    expect(screen.getByLabelText('id: NULL')).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('name'))
    await userEvent.type(screen.getByLabelText('name'), 'New')
    await userEvent.click(screen.getByLabelText('note: NULL'))
    await userEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'New', note: null }, { another: false })
  })

  it('prefills a duplicate but lets generated columns take a fresh value', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" initial={{ id: 7, name: 'Old', note: null }} onSubmit={onSubmit} />)
    expect(screen.getByLabelText('id: 既定値を使う')).toBeChecked()
    expect(screen.getByLabelText('name')).toHaveValue('Old')
    expect(screen.getByLabelText('note: NULL')).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Old', note: null }, { another: false })
  })

  it('reports "insert and add another" through the submit meta', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" allowAnother onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('name'), 'A')
    await userEvent.click(screen.getByRole('button', { name: '挿入して続ける' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'A', note: null }, { another: true })
  })

  it('keeps binary values read-only', () => {
    render(<RowForm columns={[col('blob')]} mode="edit" initial={{ blob: { $bin: 'AA==' } }} onSubmit={vi.fn()} />)
    expect(screen.getByText('バイナリ値はここでは編集できません')).toBeInTheDocument()
  })
})
