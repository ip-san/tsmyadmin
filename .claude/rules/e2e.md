---
paths:
  - "e2e/**"
  - "playwright.config.ts"
---

# E2E（Playwright）のルール

- E2E は本番ビルドを API が配信する。Playwright のプロジェクトは `chromium`（機能）/ `webkit`（機能・Safari 差分）/ `a11y` / `visual-light` / `visual-dark`
- **ビジュアルの 2 つはローカル専用**で、CI は `chromium` / `a11y` / `webkit` だけを、プロジェクトごとの別のジョブ（`e2e-run` の matrix）で並べて実行する（それぞれが自分の DB とサーバーを持つ。必須のチェック名 `e2e` は、3 つが全部通ったかを見るまとめ役のジョブ）（スナップショットは `-darwin` のみ。OS が変わると描画差で落ちるため）。したがって見た目の退行はローカルで `bun run test:e2e` を回したときにしか検出されない
- `bun run test:e2e` は毎回ビルドするが、ポート 3199 / 3198（永続セッションストアの検証用）に古いサーバーが残っていると再利用される（`reuseExistingServer`）。web を変更したら `bun run build` してから実行するか、残っているサーバーを止める
- **サーバーが決めることを確かめない。** 結合の順番、インデックスを使うか、実行計画の形は、DB の版（CI は MySQL 8.0 / 8.4・PostgreSQL 14 / 17・MariaDB）や、ほかのテストが足した行で変わる（手元の 8.4 / 17 では通っても CI で落ちる）。確かめるのは、版によらず決まること（読む表がそろっている、件数、文言）だけにする
- **spec ファイルを別の spec から import しない**（import した側でテストが二重に登録される）。複数の spec が使う手順は、`e2e/helpers.ts` か `e2e/<名前>.ts`（例: `plan.ts`）に置く
