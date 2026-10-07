---
paths:
  - "e2e/**"
  - "playwright.config.ts"
---

# E2E（Playwright）のルール

- E2E は本番ビルドを API が配信する。Playwright のプロジェクトは `chromium`（機能）/ `webkit`（機能・Safari 差分）/ `a11y` / `visual-light` / `visual-dark`
- **ビジュアルの 2 つはローカル専用**で、CI は `chromium` / `a11y` / `webkit` だけを実行する（スナップショットは `-darwin` のみ。OS が変わると描画差で落ちるため）。したがって見た目の退行はローカルで `bun run test:e2e` を回したときにしか検出されない
- `bun run test:e2e` は毎回ビルドするが、ポート 3199 / 3198（永続セッションストアの検証用）に古いサーバーが残っていると再利用される（`reuseExistingServer`）。web を変更したら `bun run build` してから実行するか、残っているサーバーを止める
