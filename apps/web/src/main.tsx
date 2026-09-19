import { loadLocale } from './config/locale.ts'

// The language first, then the app: every module of it reads its strings when it is evaluated.
void loadLocale().then(() => import('./app.tsx'))
