# code-reviewer-agent メモリ: apps/web

## web: ミューテーションのエラーフィードバック欠落パターン

- 場所: `apps/web/src/features/sql/use-saved-queries.ts`（`saveMutation`/`removeMutation`）。`onSuccess` はあるが `onError` がなく、フック自体が `error`/`isPending` を呼び出し側に返していない。`SqlPanels.tsx` の `SavedQueriesPanel` はエラー表示を一切持たない。
- この codebase の規約: `RowDialogs.tsx`（`error={update.error}` を `RowForm` に渡す）、`RowsGrid.tsx:289`（`error={remove.error}` を確認ダイアログへ）のように、`useMutation` のエラー状態を必ず呼び出し側 UI に渡して `ErrorBox` 等で表示している。この規約からの逸脱は Warning 相当。
- 注意: `main.tsx` の `MutationCache.onError` はグローバルに 401 を捕まえて `/login` へリダイレクトするので、「サイレントに失敗する」のは 401 以外（ネットワークエラー、500、`UNSUPPORTED` 400 など）に限られる。指摘時はこの限定を明記すること。

## web: セッション/クエリキャッシュのアカウント分離は検証済み・誤検出注意

- `queryClient.clear()` は `login.tsx`（ログイン成功時）と `_app.tsx`（ログアウト時）の両方にある。セッション期限切れ（`main.tsx` の `onUnauthorized`）は `clear()` を呼ばず `session` クエリだけ `null` にするが、次のログイン成功時に必ず `clear()` されるため実害のある漏洩経路にはならない（Critical/Warning にしない）。
- `useSavedQueries(scope, onServer)` の `scope`（`dialect.host.port`）は `SqlConsole` が使われている限り、サーバー切り替え = 必ず `/login` を経由 = `_app` レイアウトの完全アンマウントを伴うため、マウントしたまま `scope` だけ変わって古いブックマークが残る、という不具合は現状の画面構成では再現しない（`routes/_app.tsx` の `beforeLoad` が `session` を route context に積む設計）。将来「サーバーをその場で切り替える UI」ができたら要再検証。
- 例外的に残る経路: **別タブでログアウト→別アカウントでログイン**すると、Cookie を共有する既存タブは何もしていなくても次のリクエストから新アカウントのデータ（保存済みクエリに限らずデータベース一覧なども含む）を受け取る。これは Cookie ベースセッション全体に共通する性質でありこの PR 固有の欠陥ではないので Info 止まりでよい。

## web: aria-label を「値そのもの」の入れ物に使う誤り（SecondFactorPage）

- `apps/web/src/features/auth/SecondFactorPage.tsx:75` の `<p aria-label={t.secretLabel}>{setup.secret}</p>` は、`<p>`（暗黙ロール `paragraph`）に `aria-label` を付けている。ARIA 1.2 では `paragraph` は Name From: prohibited で、axe-core は `aria-prohibited-attr` として検出しうる。実害は AT/ブラウザの組み合わせ依存（Chrome は label をアクセシブルネームとして露出するなど挙動が割れる）なので「読み上げられない可能性がある」という言い方に留めること（「絶対読めない」と断定しない）。
- この codebase には既に正しいパターンがある: `apps/web/src/components/ui/Feedback.tsx` の `Badge`（`title` を hover 用に残しつつ `sr-only` の `<span>` で説明を別出しし、可視テキストを潰さない）。値そのものを見せたい要素には `aria-label` ではなく `<span className="sr-only">ラベル: </span>` + 可視テキストを使うべき。次に類似コード（秘密鍵・トークン・URI など「値がそのままコンテンツ」なテキスト）を見たら同じ観点でチェックする。

## web: `locale.sql.copied` を SQL 結果コピー以外で使い回す誤り

- `SecondFactorPage.tsx:97` が回復用コードのコピー成功表示に `locale.sql.copied` を再利用しているが、その文言は ja/en とも「クリップボードにコピーしました（**タブ区切り**）」/ "Copied to the clipboard (**tab-separated**)"（`ja.ts:413`, `en.ts:418`）で、SQL 結果グリッド専用の説明。回復用コードは改行区切り（`join('\n')`）でタブ区切りではなく、文脈も無関係。コピー成功文言を使い回すときは「対象データの形式に言及していないか」を必ず確認する。
- 同じファイルはコピー失敗時のフィードバックも欠落している（`copyText(...).then(() => setCopied(true), () => setCopied(false))` で失敗時は成功前と同じ空表示になる）。対照として `apps/web/src/features/sql/ResultActions.tsx`（`copied: 'done' | 'failed' | null` の3値 + `locale.sql.copyFailed`）が正しい既存パターン。コピー機能を新規に足すレビューでは必ず ResultActions.tsx と比較する。

## web: 状態遷移でフォーカスされていた要素が unmount されると focus が body に落ちる（フィードバック無音化）

- `SecondFactorPage.tsx` は `begin`/`confirm`/`disable` の各ミューテーション成功時に、直前までフォーカスがあったボタン（Enrol ボタン等）を含むブランチごと unmount して別の分岐に切り替える。結果は静的な `<p>`（`t.enrolled(...)` 等）で、live region でも見出しへのフォーカス移動でもないため、フォーカスは `<body>` に落ち、成功も内容の変化もスクリーンリーダーに一切アナウンスされない（disable 成功時は「解除できました」に相当する文言自体が存在しない）。
- `autoFocus` を新しい入力欄に付けるのは必ずしも正しい修正ではない（例: confirm 前は秘密鍵・回復用コードを先に読む必要があるので、コード入力欄に autoFocus すると読むべき内容を飛ばしてしまう）。正しい修正は「一時的な成功 Notice(role="status") を出す」+「見出し等に `tabIndex={-1}` を振ってフォーカスを移す」の組み合わせ。LoginForm.tsx の `codeNeeded` → `autoFocus` はボタンが unmount されない別パターンなので単純に真似ない。
- レビュー時のチェックリスト: ミューテーション成功時に (1) それまでフォーカスがあった要素が unmount されるか、(2) 新しい分岐に成功を示す live region があるか、を必ず両方確認する。片方だけ見ると見逃す。

## e2e: `/security`（2FA ページ）が a11y スイート未収載

- `e2e/a11y.spec.ts` は login / server / database / browse / structure / SQL / insert / events / operations 等を網羅しているが `/security` への `scan()` 呼び出しが無い。2FA 機能追加時に axe ゲートへの追加を忘れた状態が確認できた（2026-09 時点）。2FA 関連の PR をレビューするときは a11y.spec.ts への追加有無を必ず確認する。

## web: main.tsx の onUnauthorized は「認証切れ」以外の 401 も無差別に握り潰す

- `apps/web/src/main.tsx:17-22` の `onUnauthorized` は `error.status !== 401` しか見ておらず、`ApiErrorCode` は見ていない。コメント（`main.tsx:12-16`）は `UNAUTHENTICATED` / `AUTH_FAILED` を想定しているが、`apps/api/src/lib/errors.ts` の `STATUS_BY_CODE` で 401 にマップされる**新しいコード**（例: `SECOND_FACTOR_REQUIRED` / `SECOND_FACTOR_INVALID`）は、それが `/login` 以外の**認証済み画面**から飛んだ場合にも同じ扱い（セッションを null にして `/login?expired=true` へ強制遷移）を受ける。
- 2FA 実装（a595325〜9d336f6）で実際に発生: `/security` でのコード確認・解除ミス、および `TSMYADMIN_REQUIRE_2FA` 下で未登録アカウントが `/` 等の保護ルートに触れた場合の両方が、この無差別処理でログイン画面に飛ばされる。後者は `DbTree`（`_app.tsx` のレイアウトに常駐、`enabled` 条件なしで `databasesQuery` を叩く）が `/security` 自体でも発火するため、機能が UI 経由で到達不能になる重大度。
- 教訓: `STATUS_BY_CODE` に 401 を返す新コードを足すとき（今後 WebAuthn 等の別要因を足す場合も含む）は、それが「未認証（グローバルにログアウトしてよい）」なのか「認証済みだが追加の手続きが要る（ログアウトしてはいけない）」なのかを `onUnauthorized` 側で分岐しているか必ず確認する。次回もこのファイルは「404 相当の分岐漏れ」が起きやすい場所として要チェック。

## e2e a11y: 既存ページに乗る「条件付き新規 UI」はテストのセットアップ次第で一切スキャンされない

- `e2e/a11y.spec.ts:93-95` は `/users` を fixture アカウント（tsmyadmin、常にフル権限）でログインした直後・何も 2FA 登録されていない状態でスキャンする。8b1973a で追加された `SecondFactorReset` のバッジ／ボタン／確認ダイアログは `resettable.has(u.name)`（= 誰かが 2FA 登録済みでこのアカウントが解除できる）が真のときだけ描画されるため、このテストでは常に空集合になり新規 UI 要素は一度も axe でスキャンされない。同種のパターンは過去に「/security ページ自体が a11y スイート未収載」として記録済みだが、今回は「ページはスキャンされているが、ページ内の条件付き要素だけがセットアップ不足で素通りする」という一段階違う形。ダイアログの開いた状態を別途スキャンする既存パターンは `e2e/a11y.spec.ts:36-38`（テーブル削除ダイアログ）や `:125-127`。次に「既存の a11y スキャン対象ページに機能を追加した」PR を見たら、その新規要素が実際にそのテストのシナリオで描画される状態になっているかを必ず確認する（ページ到達だけでは不十分）。

## 誤検出にしないでよいパターン（本 diff で確認）

- ローカル保存モードでの `id: ''` は意図的（`SavedQuerySchema` の `id` はサーバー採番、ブラウザ側は空文字）。`key={q.id || q.name}` はこれを前提にしており問題なし。
- サーバー側 `SavedQueryStore.save()` は名前で dedupe（`existing = list().find(name)` → update/insert 分岐）するため、`entries.find(name)` が二重登録で迷子になることはない。
- ローカルストレージのスコープキー（`dialect.host.port`、ユーザー名を含まない）は本 diff より前からの既存設計。同一ブラウザで同じホストに複数アカウントでログインした場合の越境閲覧はこの機能追加が動機になっている既知の制約であり、この diff のレビューでは対象外（言及するとしても Info 止め、あるいは省略）。

