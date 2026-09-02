// Applies the stored theme before the app bundle loads so dark mode does not flash light on reload.
// Kept as an external file because the CSP allows only 'self' scripts (no inline). Mirrors lib/theme.ts.
;(function () {
  try {
    var stored = localStorage.getItem('tsmyadmin.theme')
    var dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) document.documentElement.classList.add('dark')
  } catch (_) {
    // storage unavailable: the app applies the theme once it loads
  }
})()
