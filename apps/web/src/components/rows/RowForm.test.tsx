import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ColumnDef, ColumnTransform } from '@tsmyadmin/shared'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RowForm } from './RowForm.tsx'

/** The form reads the session (for the dialect's functions): a client that already holds one. */
function render(ui: ReactElement) {
  const client = new QueryClient()
  client.setQueryData(['session'], { dialect: 'mysql' })
  // As a wrapper, so a rerender keeps it.
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

const col = (name: string, over: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  dataType: 'varchar(50)',
  nullable: true,
  default: null,
  defaultIsExpression: false,
  extra: '',
  comment: null,
  collation: null,
  check: null,
  generated: null,
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
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'Zed', note: null })
  })

  it('typing into a NULL / default field takes over from the checkbox', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" onSubmit={onSubmit} />)
    // The field is not disabled: typing unticks NULL (note) and 既定値を使う (id) like phpMyAdmin does.
    await userEvent.type(screen.getByLabelText('note'), 'typed')
    expect(screen.getByLabelText('note: NULL')).not.toBeChecked()
    await userEvent.type(screen.getByLabelText('id'), '42')
    expect(screen.getByLabelText('id: 既定値を使う')).not.toBeChecked()
    await userEvent.type(screen.getByLabelText('name'), 'A')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ id: '42', name: 'A', note: 'typed' })
    // Ticking NULL again blanks the field without losing the mode.
    await userEvent.click(screen.getByLabelText('note: NULL'))
    expect(screen.getByLabelText('note')).toHaveValue('')
  })

  it('unchecking NULL enables the input and submits its text', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" onSubmit={onSubmit} />)
    await userEvent.click(screen.getByLabelText('note: NULL'))
    await userEvent.type(screen.getByLabelText('note'), 'hi')
    await userEvent.type(screen.getByLabelText('name'), 'A')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'A', note: 'hi' })
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
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'New', note: null })
  })

  it('prefills a duplicate but lets generated columns take a fresh value', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={columns} mode="insert" initial={{ id: 7, name: 'Old', note: null }} onSubmit={onSubmit} />)
    expect(screen.getByLabelText('id: 既定値を使う')).toBeChecked()
    expect(screen.getByLabelText('name')).toHaveValue('Old')
    expect(screen.getByLabelText('note: NULL')).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'Old', note: null })
  })

  it('shows the column default as a placeholder while the default is used', () => {
    render(<RowForm columns={[col('n', { default: '42', dataType: 'int' })]} mode="insert" onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('n')).toHaveAttribute('placeholder', '42')
  })

  it('survives a column added while mounted (structure refetch)', () => {
    const { rerender } = render(<RowForm columns={columns} mode="insert" onSubmit={vi.fn()} />)
    rerender(<RowForm columns={[...columns, col('added')]} mode="insert" onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('added')).toBeInTheDocument()
  })

  it('uses a textarea for multi-line types', () => {
    render(<RowForm columns={[col('body', { dataType: 'text' })]} mode="insert" onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('body').tagName).toBe('TEXTAREA')
  })

  it('duplicating a row sends what was typed into a column whose value could not be copied', async () => {
    const onSubmit = vi.fn()
    render(
      <RowForm
        columns={[col('name'), col('body', { dataType: 'text', nullable: false })]}
        mode="insert"
        initial={{ name: 'a', body: { $text: 'head', length: 70000 } }}
        onSubmit={onSubmit}
      />
    )
    expect(screen.getByText(/複製されません/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('body'), 'typed')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: 'a', body: 'typed' })
  })

  it('keeps binary and truncated values read-only', () => {
    render(
      <RowForm
        columns={[col('blob'), col('body')]}
        mode="edit"
        initial={{ blob: { $bin: 'AA==' }, body: { $text: 'head', length: 70000 } }}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getAllByText(/ここでは編集できません/)).toHaveLength(2)
    expect(screen.queryByDisplayValue('head')).toBeNull()
  })
})

describe('RowForm (functions, files, several rows)', () => {
  it('sends a function with the field as its argument, or alone', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={[col('name'), col('stamp')]} mode="insert" onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('name'), 'Zed')
    await userEvent.selectOptions(screen.getByLabelText('name: 関数'), 'md5')
    await userEvent.selectOptions(screen.getByLabelText('stamp: 関数'), 'now')
    // A function without an argument leaves nothing to type.
    expect(screen.getByLabelText('stamp')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ name: { $fn: 'md5', arg: 'Zed' }, stamp: { $fn: 'now' } })
  })

  it('reads a file into a binary column', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={[col('pic', { dataType: 'blob' })]} mode="insert" onSubmit={onSubmit} />)
    await userEvent.upload(screen.getByLabelText('pic: ファイルから'), new File(['hi'], 'a.bin'))
    await vi.waitFor(() => expect(screen.getByLabelText('pic')).toHaveValue('a.bin'))
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[0]).toEqual({ pic: { $bin: btoa('hi') } })
  })

  it('writes the rows that were filled in, not the untouched ones', async () => {
    const onSubmit = vi.fn()
    render(<RowForm columns={[col('name', { nullable: false })]} mode="insert" rowCount={3} onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('name（1 行目）'), 'a')
    await userEvent.type(screen.getByLabelText('name（3 行目）'), 'c')
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit.mock.lastCall?.[1]).toEqual([{ name: 'a' }, { name: 'c' }])
  })

  it('refuses a row whose files together would not fit the request', async () => {
    const onSubmit = vi.fn()
    const binaries = [col('a', { dataType: 'blob' }), col('b', { dataType: 'blob' })]
    render(<RowForm columns={binaries} mode="insert" onSubmit={onSubmit} />)
    // Each under the per-file limit, both together over what one request carries.
    const half = new Uint8Array(400 * 1024)
    await userEvent.upload(screen.getByLabelText('a: ファイルから'), new File([half], 'a.bin'))
    await userEvent.upload(screen.getByLabelText('b: ファイルから'), new File([half], 'b.bin'))
    await vi.waitFor(() => expect(screen.getByLabelText('b')).toHaveValue('b.bin'))
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('合わせて大きすぎます')
  })
})

describe('RowForm input transformations', () => {
  const rule = (over: Partial<ColumnTransform>): ColumnTransform => ({
    database: 'd',
    table: 't',
    column: 'zip',
    kind: 'pattern',
    id: '',
    at: 0,
    ...over,
  })
  const form = (transform: ColumnTransform, onSubmit = vi.fn()) => {
    const inputs = new Map([[transform.column, transform]])
    render(<RowForm columns={[col('zip')]} mode="insert" inputTransforms={inputs} onSubmit={onSubmit} />)
    return onSubmit
  }

  it('says what is wrong with a value that does not match the pattern, and holds the submit back', async () => {
    const onSubmit = form(rule({ pattern: '^\\d{3}-\\d{4}$', message: 'Give a postal code' }))
    await userEvent.type(screen.getByLabelText('zip'), '12-345')
    expect(await screen.findByText('Give a postal code')).toBeInTheDocument()
    expect(screen.getByLabelText('zip')).toBeInvalid()
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.clear(screen.getByLabelText('zip'))
    await userEvent.type(screen.getByLabelText('zip'), '123-4567')
    await waitFor(() => expect(screen.queryByText('Give a postal code')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '挿入する' }))
    expect(onSubmit).toHaveBeenCalled()
  })

  it('checks at once on submit even when the field has not yet caught up with the typing', async () => {
    const onSubmit = form(rule({ pattern: '^\\d+$', message: 'Digits only' }))
    // fireEvent.change sets the value and submits in the same tick: the field's debounced check has not run.
    fireEvent.change(screen.getByLabelText('zip'), { target: { value: 'abc' } })
    fireEvent.submit(screen.getByLabelText('zip').closest('form') as HTMLFormElement)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('zip: Digits only')
  })

  it('checks JSON in an editor, and leaves an empty (NULL) value alone', async () => {
    form(rule({ kind: 'json-input' }))
    expect(screen.getByLabelText('zip').tagName).toBe('TEXTAREA')
    await userEvent.type(screen.getByLabelText('zip'), 'not json')
    expect(await screen.findByText('JSON として読めません')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('zip'))
    await waitFor(() => expect(screen.queryByText('JSON として読めません')).not.toBeInTheDocument())
  })

  it('does not judge an edit value nobody touched, but does once it is changed', async () => {
    const inputs = new Map([['zip', rule({ pattern: '^\\d+$' })]])
    render(
      <RowForm
        columns={[col('zip')]}
        mode="edit"
        initial={{ zip: 'old-style' }}
        inputTransforms={inputs}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByLabelText('zip')).toBeValid()
    await userEvent.type(screen.getByLabelText('zip'), 'x')
    await waitFor(() => expect(screen.getByLabelText('zip')).toBeInvalid())
  })
})
