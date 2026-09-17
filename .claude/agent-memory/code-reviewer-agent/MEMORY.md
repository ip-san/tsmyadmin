# code-reviewer-agent メモリ

## web: ミューテーションのエラーフィードバック欠落パターン

- 場所: `apps/web/src/features/sql/use-saved-queries.ts`（`saveMutation`/`removeMutation`）。`onSuccess` はあるが `onError` がなく、フック自体が `error`/`isPending` を呼び出し側に返していない。`SqlPanels.tsx` の `SavedQueriesPanel` はエラー表示を一切持たない。
- この codebase の規約: `RowDialogs.tsx`（`error={update.error}` を `RowForm` に渡す）、`RowsGrid.tsx:289`（`error={remove.error}` を確認ダイアログへ）のように、`useMutation` のエラー状態を必ず呼び出し側 UI に渡して `ErrorBox` 等で表示している。この規約からの逸脱は Warning 相当。
- 注意: `main.tsx` の `MutationCache.onError` はグローバルに 401 を捕まえて `/login` へリダイレクトするので、「サイレントに失敗する」のは 401 以外（ネットワークエラー、500、`UNSUPPORTED` 400 など）に限られる。指摘時はこの限定を明記すること。

## web: セッション/クエリキャッシュのアカウント分離は検証済み・誤検出注意

- `queryClient.clear()` は `login.tsx`（ログイン成功時）と `_app.tsx`（ログアウト時）の両方にある。セッション期限切れ（`main.tsx` の `onUnauthorized`）は `clear()` を呼ばず `session` クエリだけ `null` にするが、次のログイン成功時に必ず `clear()` されるため実害のある漏洩経路にはならない（Critical/Warning にしない）。
- `useSavedQueries(scope, onServer)` の `scope`（`dialect.host.port`）は `SqlConsole` が使われている限り、サーバー切り替え = 必ず `/login` を経由 = `_app` レイアウトの完全アンマウントを伴うため、マウントしたまま `scope` だけ変わって古いブックマークが残る、という不具合は現状の画面構成では再現しない（`routes/_app.tsx` の `beforeLoad` が `session` を route context に積む設計）。将来「サーバーをその場で切り替える UI」ができたら要再検証。
- 例外的に残る経路: **別タブでログアウト→別アカウントでログイン**すると、Cookie を共有する既存タブは何もしていなくても次のリクエストから新アカウントのデータ（保存済みクエリに限らずデータベース一覧なども含む）を受け取る。これは Cookie ベースセッション全体に共通する性質でありこの PR 固有の欠陥ではないので Info 止まりでよい。

## 誤検出にしないでよいパターン（本 diff で確認）

- ローカル保存モードでの `id: ''` は意図的（`SavedQuerySchema` の `id` はサーバー採番、ブラウザ側は空文字）。`key={q.id || q.name}` はこれを前提にしており問題なし。
- サーバー側 `SavedQueryStore.save()` は名前で dedupe（`existing = list().find(name)` → update/insert 分岐）するため、`entries.find(name)` が二重登録で迷子になることはない。
- ローカルストレージのスコープキー（`dialect.host.port`、ユーザー名を含まない）は本 diff より前からの既存設計。同一ブラウザで同じホストに複数アカウントでログインした場合の越境閲覧はこの機能追加が動機になっている既知の制約であり、この diff のレビューでは対象外（言及するとしても Info 止め、あるいは省略）。

## adapter: buildQuery/conditionSql の literal 経路と keyParam の前提ズレ（BIT）

- `packages/adapter/src/base.ts` の `conditionSql`/`keyParam` は元々「`Params.add()` が返すプレースホルダに、ドライバへ渡す実バイト値（`toDbValue` 済み）がバインドされる」ことを前提にした CAST（BIT は `CONV(HEX(placeholder),16,10)`）。`buildQuery`（クエリビルダー）はこれを「引用符付きリテラル文字列」経路（`literal = mysqlLiteral(String(v))` 等、base.ts:659）に転用しているが、BIT だけは前提が崩れる: `QueryBuilderConditionSchema.value`（packages/shared/src/schemas/query-builder.ts:28-36）が `z.string()` のみで `$bin`（BinaryCell）を運べないため、ユーザーが "128" のような10進文字列を入れると `HEX('128')` は文字列 "128" の ASCII バイトの16進になり、意図した BIT 値と一致しない SQL になる（実機確認済み: `types_all.bit_col`（実値 170 = X'AA'）に対し `eq '170'` で 0 件になる）。DECIMAL/FLOAT/INT/BIGINT/JSON はこの経路でも文字列→CAST が素直に効くので問題なし。BIT だけが特殊。
- `test/conformance.ts` の `describe('buildQuery')` は JSON の cast は検証しているが BIT のケースがない（見た目は「型ごとのキャストを検証しています」で網羅感があるので要注意、次回レビューでも同じ抜けが再発しやすい）。
- 教訓: `keyParam` を新しい呼び出し経路（値がリテラル文字列になる経路）に転用するときは、各方言の cast 分岐を「プレースホルダ＝バインドパラメータ」前提と「プレースホルダ＝クォート済みリテラル」前提の両方で個別に検証すること。バイナリ系（BIT/BLOB/bytea）は特に危険。

## adapter: joinPlan は同じテーブル間に複数 FK があると先勝ちで無言選択

- `packages/adapter/src/base.ts` の `joinPlan`（links.find、Array.prototype.find は最初にマッチしたリンクを採用）は、2 テーブル間に FK が複数本ある場合（例: `orders.created_by` と `orders.updated_by` が両方 `users.id` を指す）にどちらか一方だけを無言で選ぶ。選択は `describeTable` が返す `foreignKeys` の順序（MySQL: `ORDER BY CONSTRAINT_NAME`、PostgreSQL: `ORDER BY con.conname`）に依存し、命名規則が方言間で異なれば同じ論理スキーマでも MySQL と PostgreSQL で違う FK が選ばれ得る（未検証だが命名規則の違いから見て現実的な差異）。エラーにはならず、テスト（`join-plan.test.ts`、conformance の `buildQuery`）にもこのケースがない。自己参照 FK（`fk.refTable !== from` で除外）は別途安全に弾かれている。
- 次回このあたりを触ったら、複数 FK 間の曖昧性を「エラーにする」か「選択できるようにする」か方針が変わっていないか確認する。
