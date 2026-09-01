import { describe, expect, it } from 'vitest'
import { cellToEditable, cellToText, describeCell, errorMessage } from './format.ts'

describe('describeCell', () => {
  it('classifies null, binary, empty and text', () => {
    expect(describeCell(null)).toEqual({ kind: 'null' })
    expect(describeCell({ $bin: '3q2+7w==' })).toEqual({ kind: 'binary', bytes: 4 })
    expect(describeCell({ $bin: 'AQI=' })).toEqual({ kind: 'binary', bytes: 2 })
    expect(describeCell('')).toEqual({ kind: 'text', text: '', empty: true })
    expect(describeCell(42)).toEqual({ kind: 'text', text: '42', empty: false })
    expect(describeCell(true)).toEqual({ kind: 'text', text: 'true', empty: false })
  })
})

describe('cellToText / cellToEditable', () => {
  it('renders NULL and binary placeholders in Japanese', () => {
    expect(cellToText(null)).toBe('NULL')
    expect(cellToText({ $bin: 'qg==' })).toContain('1 bytes')
    expect(cellToText('x')).toBe('x')
  })

  it('never puts NULL/binary into an editor as text', () => {
    expect(cellToEditable(null)).toBe('')
    expect(cellToEditable({ $bin: 'qg==' })).toBe('')
    expect(cellToEditable(3.5)).toBe('3.5')
  })
})

describe('errorMessage', () => {
  it('maps API error codes to localized text with detail', () => {
    expect(errorMessage({ code: 'AUTH_FAILED', message: 'x', detail: 'Access denied' })).toBe(
      '認証に失敗しました: Access denied'
    )
    expect(errorMessage({ code: 'KEY_MISMATCH', message: 'm' })).toContain('一意に特定')
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })
})
