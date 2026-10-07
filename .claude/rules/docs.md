---
paths:
  - "docs/**"
  - "README.md"
  - "README.en.md"
---

# 文書（docs/・README）のルール

- `docs/*.md` と `README.md` は日本語が原文。変えたら `docs/en/` / `README.en.md` の対応箇所も訳し、`bun run docs:sync` でハッシュを打ち直す（`bun run check:static` の `docs:i18n` が fail する）。**訳してから `docs:sync` を実行する**（先に実行すると、訳していない英訳に「最新」の印が付く）
- 数字（テストの件数など）は `bun run docs:validate --fix` が同期する。手で書き換えない
