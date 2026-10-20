import { describe, expect, it } from 'vitest'
import { localVoice, sentences, type VoiceLike } from './narration.ts'

const voice = (lang: string, localService: boolean, isDefault = false, name = lang) => ({
  name,
  lang,
  localService,
  default: isDefault,
})

describe('localVoice', () => {
  it('takes only a voice the device speaks itself, never one that sends the words out', () => {
    const remote = voice('ja-JP', false, true, 'Google 日本語')
    expect(localVoice([remote], 'ja')).toBeUndefined()
    const kyoko = voice('ja-JP', true, false, 'Kyoko')
    expect(localVoice([remote, kyoko], 'ja')).toBe(kyoko)
  })

  it('matches the language whatever its region or case, and prefers the default', () => {
    const us = voice('en-US', true)
    const gb = voice('en_GB', true, true)
    const ja = voice('JA-jp', true)
    expect(localVoice<VoiceLike>([us, gb, ja], 'en')).toBe(gb)
    expect(localVoice<VoiceLike>([us, ja], 'ja')).toBe(ja)
    expect(localVoice<VoiceLike>([us], 'ja')).toBeUndefined()
    expect(localVoice<VoiceLike>([voice('english', true)], 'en')).toBeUndefined()
  })
})

describe('sentences', () => {
  it('cuts at the ends of sentences, keeping each end with its sentence', () => {
    expect(sentences('マスタ（1）。参照されるだけのテーブルです。users')).toEqual([
      'マスタ（1）。',
      '参照されるだけのテーブルです。',
      'users',
    ])
    expect(sentences('Masters (1). Only referred to! Why? users')).toEqual([
      'Masters (1).',
      'Only referred to!',
      'Why?',
      'users',
    ])
    expect(sentences('1 段目: reviews.user_id が users.id を参照。2 段目')).toEqual([
      '1 段目: reviews.user_id が users.id を参照。',
      '2 段目',
    ])
    expect(sentences('  ')).toEqual([])
  })
})
