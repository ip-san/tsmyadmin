---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
---

# カスタムスキル・エージェントの棲み分け

| スコープ | 配置場所 | 方針 |
|---------|---------|------|
| 全プロジェクト共通 | `~/.claude/skills/` | カスタムしない |
| プロジェクト固有スキル | `.claude/skills/` | 固有の教訓・ワークフロー（`self-review`, `quality-loop`） |
| プロジェクト固有エージェント | `.claude/agents/` | 品質ゲート・レビュー・テスト作成 |

- `/self-review` は `/code-review`（汎用）を呼んだ後にプロジェクト固有チェック（SQL 補間、方言パリティ、DTO 追随、ダークモード、直書き日本語）を実行する
- `/quality-loop` は review → `check:all` → size → E2E の最終ゲート
- スキルは 500 行 / 2,000 トークン以下、フロントマター必須
