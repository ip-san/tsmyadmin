/** What is read of a voice to choose it. */
export interface VoiceLike {
  lang: string
  localService: boolean
  default: boolean
}

/**
 * The voice to read a tour aloud in `lang` (`ja`, `en`): only one the device speaks itself. A voice that is not
 * `localService` sends the words to a service outside (Chrome's "Google" voices do), and a tour's words are the
 * database's table and column names. Of those left, the device's default first. None when the device has none.
 */
export function localVoice<V extends VoiceLike>(voices: readonly V[], lang: string): V | undefined {
  const fits = voices.filter((v) => v.localService && v.lang.toLowerCase().split(/[-_]/)[0] === lang.toLowerCase())
  return fits.find((v) => v.default) ?? fits[0]
}

/**
 * The words in sentences, each read as one utterance: a long one is cut off part way by some browsers (Chrome stops
 * after about 15 seconds). A sentence ends at `。` `！` `？` (and `!` `?`), or at a `.` with a space after it: the dot
 * of `users.id` is not one.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[。．！？!?])|(?<=\.)(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
