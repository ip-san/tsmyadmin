# code-reviewer-agent メモリ: packages/adapter

## adapter: buildQuery/conditionSql の literal 経路と keyParam の前提ズレ（BIT）

- `packages/adapter/src/base.ts` の `conditionSql`/`keyParam` は元々「`Params.add()` が返すプレースホルダに、ドライバへ渡す実バイト値（`toDbValue` 済み）がバインドされる」ことを前提にした CAST（BIT は `CONV(HEX(placeholder),16,10)`）。`buildQuery`（クエリビルダー）はこれを「引用符付きリテラル文字列」経路（`literal = mysqlLiteral(String(v))` 等、base.ts:659）に転用しているが、BIT だけは前提が崩れる: `QueryBuilderConditionSchema.value`（packages/shared/src/schemas/query-builder.ts:28-36）が `z.string()` のみで `$bin`（BinaryCell）を運べないため、ユーザーが "128" のような10進文字列を入れると `HEX('128')` は文字列 "128" の ASCII バイトの16進になり、意図した BIT 値と一致しない SQL になる（実機確認済み: `types_all.bit_col`（実値 170 = X'AA'）に対し `eq '170'` で 0 件になる）。DECIMAL/FLOAT/INT/BIGINT/JSON はこの経路でも文字列→CAST が素直に効くので問題なし。BIT だけが特殊。
- `test/conformance.ts` の `describe('buildQuery')` は JSON の cast は検証しているが BIT のケースがない（見た目は「型ごとのキャストを検証しています」で網羅感があるので要注意、次回レビューでも同じ抜けが再発しやすい）。
- 教訓: `keyParam` を新しい呼び出し経路（値がリテラル文字列になる経路）に転用するときは、各方言の cast 分岐を「プレースホルダ＝バインドパラメータ」前提と「プレースホルダ＝クォート済みリテラル」前提の両方で個別に検証すること。バイナリ系（BIT/BLOB/bytea）は特に危険。

## adapter: joinPlan は同じテーブル間に複数 FK があると先勝ちで無言選択

- `packages/adapter/src/base.ts` の `joinPlan`（links.find、Array.prototype.find は最初にマッチしたリンクを採用）は、2 テーブル間に FK が複数本ある場合（例: `orders.created_by` と `orders.updated_by` が両方 `users.id` を指す）にどちらか一方だけを無言で選ぶ。選択は `describeTable` が返す `foreignKeys` の順序（MySQL: `ORDER BY CONSTRAINT_NAME`、PostgreSQL: `ORDER BY con.conname`）に依存し、命名規則が方言間で異なれば同じ論理スキーマでも MySQL と PostgreSQL で違う FK が選ばれ得る（未検証だが命名規則の違いから見て現実的な差異）。エラーにはならず、テスト（`join-plan.test.ts`、conformance の `buildQuery`）にもこのケースがない。自己参照 FK（`fk.refTable !== from` で除外）は別途安全に弾かれている。
- 次回このあたりを触ったら、複数 FK 間の曖昧性を「エラーにする」か「選択できるようにする」か方針が変わっていないか確認する。

## adapter: MySQL canManageAccount の SYSTEM_USER 要件は「対象非依存」で意図的・テストで固定済み（Critical に格上げしない）

- `packages/adapter/src/mysql/users.ts` の `mysqlCanManageAccount` は、対象アカウント（`name` 引数）が実際に SYSTEM_USER を持つかを見ず、常に「自分が SYSTEM_USER を持っているか」だけをサーバーが対応していれば要求する。実機検証済み（MySQL 8.4.11）: `CREATE USER` のみを持つ管理者アカウントは、SYSTEM_USER を持たない普通のアカウントの `ALTER USER ... IDENTIFIED BY` に実際には成功する（本物の MySQL の挙動）のに、アプリの `canManageAccount` は false を返す。これは fail-closed 方向（過剰に制限）であり、over-permissive ではないので Critical/Warning の「認可の穴」には当たらない。`test/conformance.ts` の `expect(await admin.canManageAccount('tsmyadmin')).toBe(mariadb)`（8.4 では false 期待）で契約として固定されている＝意図的な設計。次にこの箇所をレビューするときは「対象依存にすべき」という指摘を Critical にしない。実務上の懸念は「CREATE USER はあるが SYSTEM_USER までは持たない、という比較的よくある権限構成の運用者には、この機能が事実上使えない」という UX 上の Warning に留める。

## adapter: バージョン文字列パーサが NaN で「安全側に倒れない」唯一の穴（`hasSystemUser`）

- `packages/adapter/src/mysql/users.ts` の `hasSystemUser`: `version.split(/[.-]/).map(Number)` の分割要素が数値に変換できない場合（配列に要素自体は存在するので分割代入のデフォルト値 `= 0` は発動しない）、`Number(...)` は `NaN` になる。`NaN >= 16` は常に `false` になるため、`8.0.<非数値>` のようなバージョン文字列だと `hasSystemUser` が `false`（＝ SYSTEM_USER 不要）を返し、`mysqlCanManageAccount` が要求を緩める方向に倒れる。この機能の中で唯一「壊れた入力が安全側でなく危険側に倒れる」経路。実 MySQL 8.4.11 の `VERSION()` は綺麗な数値なので再現できないが、MySQL 互換プロキシ/フォーク（ProxySQL、Vitess、一部のクラウド管理型 MySQL 等）が非標準の `VERSION()` 文字列を返す場合に理論上該当しうる。次に類似のバージョン文字列パースを見たら「配列の欠落要素」と「NaN になる要素」を分けて考え、NaN 側もフェイルクローズ（未知の形式は「保護機能あり」とみなす）にすべきという指摘をする。



## adapter/shared: MySQL の DELIMITER 切り替え（sql-script.ts）は末尾の行コメントに閉じ記号ごと飲み込まれる（a1ce017 で実機確認済み）

- 場所: packages/shared/src/sql-script.ts の sqlScript()。MySQL でボディに ; を含む文（createRoutine/createTrigger/createEvent）を DELIMITER 切り替えで包むとき、選んだ delimiter を statement の末尾へ改行なしで直接連結する（`${s}${delimiter}`）。
- 壊れるケース: ユーザーが本体の最後の行に -- または # の行コメントを書く（`END; -- done` のようなごく普通のスタイル）と、追記された閉じ delimiter（既定は $$）がそのコメント行に吸収され、packages/adapter/src/sql/split.ts の splitStatements がコメント内の閉じ記号を認識できない。結果、後続の DELIMITER ; 行まで一つの巨大な文として取り込まれ、MySQL に「DELIMITER」という生テキストを含む SQL を送って構文エラーになる（プレビューでは正しく見える生成 SQL が実行時にだけ壊れる）。
- 実機再現（MySQL 8.4、tsmyadmin_test）: `CREATE TRIGGER ... BEGIN SET @x = 1; END; -- trigger done` を sqlScript('mysql', [...]) -> splitStatements -> conn.query() の順で流すと ER_PARSE_ERROR（'DELIMITER' 付近の構文エラー）。mysql/ddl.ts の bare()（末尾の ; だけを削る関数）で末尾が `... -- close\n;` のように「コメントの後に改行+セミコロンだけ」という形でも同様に再現する。
- packages/shared/src/sql-script.test.ts にはこのケースがない（末尾コメントなしの単純な ; を含む文のみ）。test/conformance.ts の createRoutine/createTrigger/createEvent のボディもすべて末尾がコメントなしなので、mutation を入れても検出できない抜け。
- 修正案（提案のみ、実施はしていない）: delimiter を追記する前に改行を挟む（`${s}\n${delimiter}`）。splitStatements は複数文字delimiterを行頭に限定せずどこでも認識するので、行コメントの外に出すだけで直る。
- 次にこのファイルを触ったら、末尾が行コメントで終わる本体（-- comment の後に空白/; だけが続く、または ; の後に -- comment が続く）を必ずテストケースに足す。PostgreSQL 側の dollarQuoted()（postgres/ddl.ts）は閉じタグの前に必ず改行を挟む実装になっており、同じ問題は起きない（意図的か偶然かは不明だが、参考実装として比較に使える）。

## adapter: `replaceInColumn` の MySQL 版 `WHERE REPLACE(...) <> c` は照合順序比較で「置換で変わった行」まで落とす（f9f3d6f で実機確認・Critical）

- 場所: `packages/adapter/src/mysql/ddl.ts` の `replaceInColumn`（`WHERE ${replaced} <> ${c}`）。`REPLACE()` 自体はどの照合順序でもバイト完全一致（大文字小文字・アクセントを区別する）検索だが、生成した `<>` 比較はカラムの照合順序で評価される。MySQL 8 の既定照合順序 `utf8mb4_0900_ai_ci`（大文字小文字・アクセント無視）の列で `find='ABC', replace='abc'`（大文字小文字だけの置換）を実行すると、`REPLACE(v,'ABC','abc')` は正しく `'abc'` を返すのに、`'abc' <> 'ABC'` が ai_ci では偽と評価され、`WHERE` がその行を落として **0 行更新**になる（`ROW_COUNT()=0`、実機 MySQL 8.4 で確認済み）。コミットメッセージ・conformance のコメント（「MySQL の照合順序では一致でも置換で変わらない行を触らない」）は `REPLACE()` 側のバイト完全一致だけを検証しており、`<>` 側が照合順序で緩む方向の危険は未検証のまま残っていた。
- 再現時の注意: `docker compose exec mysql mysql ...` で日本語やアクセント付き文字（café 等）を検証すると、クライアント側の文字コード既定（latin1）で文字化けし誤った結果を見ることがある。`mysql --default-character-set=utf8mb4 ...` を必ず付けること（一度 café のテストで自分がこれにハマった）。ASCII の大文字小文字違い（ABC/abc）なら文字コード起因のノイズなしに再現できる。
- 修正案: `<>` を `CAST(... AS BINARY) <> CAST(... AS BINARY)` にする（`BINARY expr` 構文は MySQL 8.0.27+ で非推奨、`SHOW WARNINGS` で Warning 1287 が出ることを確認済み。`CAST(expr AS BINARY)` なら警告なし）。PostgreSQL 側の `IS DISTINCT FROM` は decisive collation（既定の libc 系）では `=`/`<>` がバイト比較そのものなので同じ穴はない（`citext` 型や nondeterministic ICU 照合順序を使えば理論上再現しうるが未検証・対応不要）。
- 教訓: 「`REPLACE()`（または類似の文字列関数）の入力側は大文字小文字を区別するか」と「その結果を比較する `<>`/`=` 演算子が列の照合順序でどう評価されるか」は別の質問。片方だけテストして「照合順序は検証した」と思い込みやすい（このコミットの conformance テストのコメントが実例）。次に同種の「変更があった行だけ更新する」パターン（`<>` や `IS DISTINCT FROM` で before/after を比較する箇所）を見たら、大文字小文字・アクセントだけが変わるケースを必ず追加でテストすること。
