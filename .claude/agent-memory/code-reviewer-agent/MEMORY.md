# code-reviewer-agent メモリ

領域別ファイルに分割済み（200 行/25KB を超えたため）。レビュー対象のファイルに応じて読むこと。

- adapter.md - packages/adapter/**, packages/shared/src/sql-script.ts, packages/shared/src/schemas/** など DB 抽象層 / SQL 生成
- api-routes.md - apps/api/src/** （ルート、セッション、エクスポート/インポートなど）
- web.md - apps/web/src/** （フォーム、ミューテーション、a11y、locale、e2e）

各ファイルの見出し（## で始まる行）が事例の索引。新しい事例は対象領域のファイルに追記し、このインデックスは更新不要（見出しは各ファイル内で自己完結させる）。
