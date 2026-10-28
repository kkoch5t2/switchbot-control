# SwitchBot Control

Cloudflare Workersで動く、SwitchBot機器を操作するMCPサーバーです。登録した機器の一覧・状態確認・電源ON/OFFを、OAuthで接続したMCPクライアントから実行できます。実行に自宅PCは必要ありません。

単一所有者向けの構成です。利用する人が自分のCloudflareアカウントに配置し、自分のSwitchBot API情報と管理用パスワードを設定します。

## 構成と機能

MCPクライアント → Cloudflare Workers → SwitchBot公式API → 登録済み機器

- OAuth認証、PKCE、動的クライアント登録、CIMDに対応。
- 操作対象と許可操作を `DEVICES_JSON` で制限。
- OAuth情報は専用のCloudflare KVに保存。
- PC用プラグのOFFには、呼び出し側の正常終了確認が必要。

## SwitchBot側の準備

1. SwitchBotアプリで、使用する機器を同じ所有者アカウントに登録します。プラグミニ（JP）は2.4GHz Wi-Fiに接続し、用途がわかる名前を付けます。
2. SwitchBotアプリの開発者向けオプションから、公式APIのTokenとSecretを取得します。アプリV9以降の公式手順は「プロフィール → 設定（Preferences）→ About → App Versionを10回タップ → Developer Options → Get Token」です。表示名はアプリの言語・版で異なります。
3. 公式APIの署名付き `GET https://api.switch-bot.com/v1.1/devices` で機器一覧を取得し、名前と機種を照合して `deviceId` を確認します。この値を登録JSONの `id` に使います。署名方法は[SwitchBot公式API](https://github.com/OpenWonderLabs/SwitchBotAPI#authentication)を参照してください。

このMCPの `list_devices` は、登録済みの機器だけを返します。SwitchBotアカウント内の新しい機器を自動検出する機能ではありません。Token・Secret・機器IDや実際の登録JSONは、公開リポジトリへ追加しないでください。

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

`ready: true` はWorker内の設定チェックの結果です。SwitchBotへの接続や実機操作の成功を示すものではありません。MCPへのOAuth接続後、機器一覧と個別の状態取得も確認します。

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

keyは小文字英数字から始め、小文字英数字・ハイフン・アンダースコアで64文字以内にします。`actions` は実機が公式APIで対応する操作だけを指定してください。この実装は状態取得と `turnOn` / `turnOff` に対応します。調光、温度設定、カーテン開閉などの専用コマンドは実装していません。

## 既存MCPに機器を追加する

1. 既存の機器と同じSwitchBotアカウントに新しい機器を登録し、公式APIの機器一覧で `deviceId` を確認します。同じアカウントなら既存のAPI Token・Secretを使用できます。
2. 非公開で保管している登録JSONに、新しいkeyと設定を追記します。**既存のkey・ID・許可操作を残し、登録一覧全体を更新します。** PC用プラグには `requiresShutdown: true` を付けます。
3. CloudflareのWorker設定で、Secret **`DEVICES_JSON` の値を更新して反映**します。手元のJSONやGitHubのサンプルを編集するだけでは、本番の登録は変わりません。
4. MCPから `list_devices` を呼び、新旧両方の機器を確認します。続いてそれぞれのkeyで `get_device_status` を呼び、名前・状態・エラーの有無を確認します。

機器追加だけなら、別Workerの作成、Workerコードの再ビルド、MCPの再登録は不要です。既存のOAuth接続をそのまま利用できます。

実際の登録JSONはアクセスを制限した非公開の場所で管理してください。Cloudflareに保存したSecretの値は、APIから再取得できません。このリポジトリには機器登録の例だけを置きます。

## MCPクライアントから接続

- サーバーURL: 自分のWorkerのHTTPS URLに `/mcp` を付けたもの。
- 認証: OAuth（動的クライアント登録に対応）。
- 許可画面: 自分で設定した `OWNER_PASSWORD` を入力して接続を許可。

動的クライアント登録（DCR）を利用する場合、固定のClient ID・Client Secretは設定不要です。状態取得には `devices:read`、電源操作には加えて `devices:control` の許可が必要です。

CloudflareやSwitchBotのログインパスワードを入力するものではありません。

## ツール

| ツール | 内容 |
|---|---|
| `list_devices` | 登録済みのkey・名前・許可操作を取得。機器IDは返しません |
| `get_device_status` | `device` に登録keyを指定して状態を取得 |
| `set_device_power` | `device` と `power: "on"` または `"off"` を指定 |

`requiresShutdown: true` の機器をOFFにするには、PCのOSを正常終了し、停止を確認してから `shutdown_confirmed: true` を渡します。この引数は呼び出し側の確認申告であり、Worker自身がOSの停止を自動検証するものではありません。

SwitchBot APIの受付成功と実機の状態変更完了は別です。操作後は `get_device_status` で確認してください。タイムアウト時も状態を確認してから再操作します。

## PCをプラグONで自動起動させる

スマートプラグのONは給電の開始です。PC本体の自動起動には、BIOS/UEFI側で通電復帰時に起動する設定が必要です。MCPや `requiresShutdown` の設定だけでは自動起動しません。

BMAX B4 Turboの実機で確認した画面では、起動直後にDeleteキーでBIOSを開き、**Chipset → Auto Power On → Power On** に変更し、**F10 → Yes** で保存しました。検証時の変更前の表示は `Power Off` でした。

機種・BIOS版によって項目名や保存キーが異なります。[BMAX公式の別画面の例](https://www.bmaxit.com/Automatic-power-on-setting-BIOS-id62003017.html)は `Chipset → South Cluster Configuration → State After G3 → S0 State`、保存はF4です。実際の画面表示に合わせて設定してください。

### 実機での確認順序

1. BIOS設定を保存してOSを起動し、リモート接続と必要なサービスの動作を確認します。
2. 実行中の処理を確認し、アプリ・データベースなどを適切に停止してからOSを正常シャットダウンします。**このMCPにはOSのシャットダウン機能はありません。** OS側の操作は別の管理手段で行います。
3. 正常終了の操作結果と、本体の電源表示・消費電流などを合わせて停止を確認します。ネットワーク応答がないことだけを、正常終了の証拠にしないでください。
4. `set_device_power` に対象key、`power: "off"`、`shutdown_confirmed: true` を渡します。`get_device_status` で `power: "off"` を確認します。
5. 電源断の間隔を置いてから、同じkeyに `power: "on"` を送ります。`get_device_status` で `power: "on"` を確認します。
6. 本体の電源ボタンを押さずにOSが起動し、リモート接続と必要なサービスが復帰することを確認します。OSの起動IDや稼働時間の変化も確認します。

OS起動後にリモート管理サーバーやトンネルも自動復帰させるには、それぞれの常駐サービスを別途自動起動に設定します。コンテナやBotも自動復帰するとは限りません。Dockerの再起動ポリシーやジョブの起動方法に応じて確認してください。

## 認証と運用

Cloudflare公式 `@cloudflare/workers-oauth-provider` 1.2.3を使用します。権限は `devices:read` / `devices:control` / `offline_access`。アクセストークンは1時間、リフレッシュトークンは30日が上限です。

所有者パスワードを変更しても、発行済みOAuthトークンは即座には失効しません。即時停止は専用KV内のOAuth記録を削除するか、Workerを停止して行います。許可画面はOrigin・Cookie・一度限りの許可情報を検証します。

## テスト

`npm test` は、OAuth・PKCE・許可画面の再利用拒否・権限制御・未登録機器の拒否・PC電源OFFの確認・SwitchBot API署名を確認します。SwitchBot API通信はモックで、実機の電源は変更しません。

`npm run test:runtime` は、Miniflare/workerdで生成済みWorkerを実行し、OAuthとMCPの流れを確認します。実際のCloudflare環境やSwitchBot実機の動作確認を代替するものではありません。

2026-10-29の実機確認では、既存MCPに2台目のプラグを追加し、既存のOAuth接続で両方の一覧・状態取得ができました。BMAX B4 Turboでは、正常シャットダウン → プラグOFF確認 → ON確認 → 本体ボタンなしのUbuntu起動 → MCP再接続と常駐サービスの復帰まで確認しています。この追加検証は、空のCloudflareアカウントからの初期構築を再実行したものではありません。

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
