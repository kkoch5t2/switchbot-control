# SwitchBot Control

Cloudflare Workersで動く、SwitchBot機器を操作するMCPサーバーです。登録した機器の一覧・状態確認・電源ON/OFFを、OAuthで接続したMCPクライアントから実行できます。実行に自宅PCは必要ありません。

単一所有者向けの構成です。利用する人が自分のCloudflareアカウントに配置し、自分のSwitchBot API情報と管理用パスワードを設定します。

## 構成と機能

MCPクライアント → Cloudflare Workers → SwitchBot公式API → 登録済み機器

- OAuth認証、PKCE、動的クライアント登録、CIMDに対応。
- 操作対象と許可操作を `DEVICES_JSON` で制限。
- OAuth情報は専用のCloudflare KVに保存。
- PC用プラグのOFFには、呼び出し側の正常終了確認が必要。

## ビルドと配置

Node.js 24以上、Cloudflare Workers、専用KV namespace、SwitchBot公式API Token・Secretが必要です。

```sh
npm ci
npm test
npm run build
WORKER_FILE=./worker.js npm test
npm run test:runtime
```

1. CloudflareにWorkerを作成し、公開URLを確認します。
2. `src.mjs` の `PRODUCTION_ORIGIN` を、そのWorkerのHTTPS originに変更します。例示値は `https://switchbot-control.example.com` です。末尾の `/` や `/mcp` は付けません。
3. `npm run build` で `worker.js` を生成します。
4. Workerのコード編集画面に、生成した `worker.js` を配置します。JavaScriptモジュール形式のWorkerとして実行してください。
5. 下記のSecretsとKV bindingを設定します。
6. Runtimeのcompatibility flagに `global_fetch_strictly_public` を追加します。元の配置で使用したcompatibility dateは `2026-10-21` です。
7. 自分のWorkerの `/health` で `ready: true` を確認します。

同梱の `worker.js` は例示originでビルドしたものです。自分のoriginへ変更して再ビルドしてください。別originへの要求を拒否する設計です。テストも例示originを使うため、origin変更後にテストする場合は `test.mjs` と `runtime-smoke.mjs` のoriginも同じ値に合わせます。

## SecretsとKV

WorkerのVariables and Secretsに、次の4項目をSecretとして設定します。実際の値をソースやGitへ書き込まないでください。

| 名前 | 内容 |
|---|---|
| `SWITCHBOT_TOKEN` | SwitchBot公式API Token |
| `SWITCHBOT_SECRET` | SwitchBot公式API Secret |
| `OWNER_PASSWORD` | このMCP連携専用のパスワード。24文字以上・最大512文字 |
| `DEVICES_JSON` | 操作対象の機器と許可操作を登録するJSON |

OAuth情報専用のKV namespaceを作成し、Workerのbinding名 `OAUTH_KV` で接続します。他のアプリのKVと共有しないでください。

`DEVICES_JSON` の例（IDは実際の機器IDへ置換）:

```json
{
  "pc": {
    "name": "PC電源",
    "id": "REPLACE_WITH_DEVICE_ID",
    "actions": ["status", "on", "off"],
    "requiresShutdown": true
  },
  "desk_lamp": {
    "name": "デスクライト",
    "id": "REPLACE_WITH_OTHER_DEVICE_ID",
    "actions": ["status", "on", "off"]
  }
}
```

機器を追加する場合は、同じJSONにkeyと設定を追加します。機器ごとに別Workerを作る必要はありません。`actions` は実機が公式APIで対応する操作だけを指定してください。この実装は状態取得と `turnOn` / `turnOff` に対応します。調光、温度設定、カーテン開閉などの専用コマンドは実装していません。

## MCPクライアントから接続

- サーバーURL: 自分のWorkerのHTTPS URLに `/mcp` を付けたもの。
- 認証: OAuth（動的クライアント登録に対応）。
- 許可画面: 自分で設定した `OWNER_PASSWORD` を入力して接続を許可。

CloudflareやSwitchBotのログインパスワードを入力するものではありません。

## ツール

| ツール | 内容 |
|---|---|
| `list_devices` | 登録済みのkey・名前・許可操作を取得。機器IDは返しません |
| `get_device_status` | `device` に登録keyを指定して状態を取得 |
| `set_device_power` | `device` と `power: "on"` または `"off"` を指定 |

`requiresShutdown: true` の機器をOFFにするには、PCのOSを正常終了し、停止を確認してから `shutdown_confirmed: true` を渡します。この引数は呼び出し側の確認申告であり、Worker自身がOSの停止を自動検証するものではありません。

SwitchBot APIの受付成功と実機の状態変更完了は別です。操作後は `get_device_status` で確認してください。タイムアウト時も状態を確認してから再操作します。

## 認証と運用

Cloudflare公式 `@cloudflare/workers-oauth-provider` 1.2.3を使用します。権限は `devices:read` / `devices:control` / `offline_access`。アクセストークンは1時間、リフレッシュトークンは30日が上限です。

所有者パスワードを変更しても、発行済みOAuthトークンは即座には失効しません。即時停止は専用KV内のOAuth記録を削除するか、Workerを停止して行います。許可画面はOrigin・Cookie・一度限りの許可情報を検証します。

## テスト

`npm test` は、OAuth・PKCE・許可画面の再利用拒否・権限制御・未登録機器の拒否・PC電源OFFの確認・SwitchBot API署名を確認します。SwitchBot API通信はモックで、実機の電源は変更しません。

`npm run test:runtime` は、Miniflare/workerdで生成済みWorkerを実行し、OAuthとMCPの流れを確認します。実際のCloudflare環境やSwitchBot実機の動作確認を代替するものではありません。

## 主なファイル

| ファイル | 内容 |
|---|---|
| `src.mjs` | サーバーのソース |
| `worker.js` | 依存ライブラリを含む生成済みWorker |
| `build.mjs` | ビルド処理 |
| `test.mjs` | OAuth・MCP・機器操作のテスト |
| `runtime-smoke.mjs` | workerdでの動作確認 |
| `THIRD_PARTY_LICENSES.txt` | 同梱する第三者コードのライセンス |

## ライセンス・参照先

MIT License。第三者コードの条件は `THIRD_PARTY_LICENSES.txt` を参照してください。

- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
- [SwitchBot公式API](https://github.com/OpenWonderLabs/SwitchBotAPI)
