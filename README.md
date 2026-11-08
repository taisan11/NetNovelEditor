# NetNovelEditor

Solid + Hono / Cloudflare Workers + Turso の小説エディターです。Googleで会員登録・ログインできます。未ログインでも端末内で編集できます。

## 開発

```sh
bun install
cp .dev.vars.example .dev.vars
```

`.dev.vars` に開発用TursoとGoogle OAuthの認証情報を設定し、`bun run dev` で起動します。フロントエンドにシークレットを渡す `VITE_` プレフィックスは使用しません。

## Google OAuth設定

1. Google Cloud Console / Google Auth Platformで同意画面を設定します。テスト公開中の場合は利用するGoogleアカウントをテストユーザーに追加してください。
2. OAuthクライアント（アプリケーションの種類: **ウェブアプリケーション**）を作成します。
3. 「承認済みのリダイレクトURI」に以下を登録します（末尾スラッシュなし）。
   - 開発: `http://localhost:5173/api/auth/google/callback`
   - 本番: `https://nne.taisan11.dev/api/auth/google/callback`
4. クライアントIDを `GOOGLE_ID`、シークレットを `GOOGLE_SECRET` に設定します。`GOOGLE_REDIRECT_URI` は実際のアクセス元と同一オリジンにしてください。開発ポートを変更した場合はGoogle側と `.dev.vars` の両方を変更します。

本番では次のシークレットを設定します。

```sh
bunx wrangler secret put GOOGLE_ID
bunx wrangler secret put GOOGLE_SECRET
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put TURSO_TOKEN
```

`JWT_SECRET` は十分に長いランダム値にしてください（例: `openssl rand -hex 32`）。本番の `GOOGLE_REDIRECT_URI` と `TURSO_URL` は `wrangler.jsonc` で設定します。

設定画面の「Googleで登録・ログイン」から認証します。初回は会員を自動作成し、次回以降は同じGoogle IDの会員としてログインします。メールアドレスが変わっても同じ会員です。確認済みメールのみ許可し、GoogleトークンはDBやブラウザに保存しません。セッションは7日間のHttpOnly Cookieです。

## DBの準備・旧認証からの移行

DBコマンドは `.env` の `TURSO_URL` / `TURSO_TOKEN` を使用します（`.dev.vars` とは別です）。実行前に対象DBを確認してください。

- **新規DB**: `bun run db:mg`
- **旧ID・パスワード認証のDB**: バックアップ後、次のコマンドを実行します。

```sh
bun run db:migrate-google --confirm-reset
```

**旧DB移行は既存の全ユーザーとクラウド上の全作品・全話を削除します。** トランザクション内で認証テーブルを置き換えます。移行済みなら何も変更しません。既存DBに先に `db:mg` を実行しないでください。移行完了後に新コードをデプロイしてください。旧セッションは無効になります。

端末内の作品は削除しません。必要なら設定画面でバックアップ・インポートしてください。ログイン後は端末内の未送信作品を自動同期します。共有端末・別アカウントへの切り替えでは、この端末内データも同期対象になる点に注意してください。

## 検証・デプロイ

```sh
bun test
bun run build
bunx wrangler deploy
```

実際のGoogleログインには上記のOAuthクライアント設定が必要です。
