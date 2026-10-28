import { OAuthProvider, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';

const VERSION = '1.0.3';
const PRODUCTION_ORIGIN = 'https://switchbot-control.example.com';
const SCOPES = ['devices:read', 'devices:control', 'offline_access'];
const ENCODER = new TextEncoder();
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { ...SECURITY_HEADERS, ...headers },
});

function registry(env) {
  const value = JSON.parse(env.DEVICES_JSON || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid registry');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('Too many devices');
  for (const [key, device] of entries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || !device || typeof device !== 'object' ||
        typeof device.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(device.id) ||
        typeof device.name !== 'string' || device.name.length < 1 || device.name.length > 100 ||
        !Array.isArray(device.actions) || device.actions.length < 1 ||
        device.actions.some(a => !['status', 'on', 'off'].includes(a)) ||
        (device.requiresShutdown !== undefined && typeof device.requiresShutdown !== 'boolean')) {
      throw new Error('Invalid registry entry');
    }
  }
  return value;
}

function missingSettings(env) {
  const missing = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'OWNER_PASSWORD', 'DEVICES_JSON']
    .filter(key => !env[key]);
  if (!env.OAUTH_KV) missing.push('OAUTH_KV');
  if (env.OWNER_PASSWORD && env.OWNER_PASSWORD.length < 24) missing.push('OWNER_PASSWORD_MIN_24_CHARACTERS');
  try { registry(env); } catch { missing.push('DEVICES_JSON_INVALID'); }
  return missing;
}

async function bodyText(request, maxBytes = 32768) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const parts = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
    parts.push(item.value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(all);
}

async function equalSecret(value, secret) {
  const [a, b] = await Promise.all([value, secret].map(v => crypto.subtle.digest('SHA-256', ENCODER.encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function page(details, handle) {
  const names = { 'devices:read': '登録機器の一覧・状態の確認', 'devices:control': '登録機器の電源ON／OFF', 'offline_access': '再ログインを減らすための接続更新' };
  const scopeInputs = SCOPES.map(scope => `<label><input type="checkbox" name="scope" value="${scope}" checked> ${names[scope]}</label>`).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SwitchBot連携の許可</title>
  <style>body{font:16px/1.7 system-ui;background:#f6f7f9;color:#17212b;margin:0;padding:24px}main{max-width:520px;margin:24px auto;background:white;border:1px solid #ddd;border-radius:18px;padding:24px}h1{font-size:23px}label{display:block;margin:14px 0}input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #aaa;border-radius:8px;font:inherit}button{padding:12px 18px;margin:12px 8px 0 0;border:0;border-radius:8px;font:inherit}button[value=approve]{background:#1267d6;color:white}.note{font-size:14px;color:#52606c;overflow-wrap:anywhere}</style>
  <main><h1>SwitchBot連携の許可</h1><p>接続元：<strong>${escapeHtml(details.clientName)}</strong></p>
  <p class="note">${details.clientDomain ? `公開元ドメイン：${escapeHtml(details.clientDomain)}` : 'この接続元の表示名は、接続元自身が登録したものです。'}<br>接続の戻り先：<strong>${escapeHtml(details.redirectHost)}</strong></p>
  ${details.redirectIsLoopback ? '<p>この接続はPC内のアプリへ戻ります。自分で接続を開始した場合だけ許可してください。</p>' : ''}
  <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">${scopeInputs}
  <label for="password">この連携に設定した所有者パスワード</label><input id="password" type="password" name="password" autocomplete="current-password" maxlength="512">
  <p class="note">CloudflareやSwitchBotのログインパスワードではありません。WorkerのOWNER_PASSWORDに設定した専用パスワードです。</p>
  <button name="decision" value="approve">接続を許可</button><button name="decision" value="deny">キャンセル</button></form></main></html>`;
}

function authorizationFailure(error) {
  if (error instanceof CimdFetchError) return {
    reason: 'client_metadata_unavailable',
    message: 'ChatGPTの接続情報を取得できませんでした。ChatGPTから接続を開始し直してください。',
  };
  const failures = {
    'Missing transaction handle': ['consent_handle_missing', '認証画面の確認情報がありません。ChatGPTから接続を開始し直してください。'],
    'This authorization was not started in this browser; start again': ['consent_cookie_missing', '認証画面で発行したCookieが送信されませんでした。Cookieを許可し、同じブラウザでChatGPTから接続を開始し直してください。'],
    'This authorization belongs to a different browser session; start again': ['consent_cookie_mismatch', '認証画面とブラウザの確認情報が一致しません。ChatGPTから接続を開始し直してください。'],
    'This authorization expired or was already used; start again': ['consent_expired_or_used', 'この認証画面は有効期限の10分を過ぎたか、既に使用されています。ChatGPTから接続を開始し直してください。'],
  };
  const [reason, message] = failures[error.description] || ['authorization_request_invalid', '接続要求を検証できませんでした。ChatGPTから接続を開始し直してください。'];
  return { reason, message };
}

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/authorize') return json({ service: 'switchbot-control', version: VERSION, mcp: '/mcp' });
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === 'GET') {
        const auth = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(auth);
        const consent = await oauth.beginConsent(auth);
        const headers = new Headers(consent.headers);
        for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
        // A no-referrer policy makes native HTML form POSTs send Origin: null.
        // Keep the form's same-origin Origin while withholding referrers externally.
        headers.set('Referrer-Policy', 'same-origin');
        headers.set('Content-Type', 'text/html; charset=utf-8');
        // Chrome applies form-action to the POST's redirects as well. Permit the
        // destination already validated against this client's registered URI.
        // Native private-use URIs have no origin, so use their specific scheme.
        const redirect = new URL(details.redirectUri);
        const redirectSource = redirect.origin === 'null' ? redirect.protocol : redirect.origin;
        headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectSource}; base-uri 'none'; frame-ancestors 'none'`);
        return new Response(page(details, consent.handle), { headers });
      }
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'invalid_origin' }, 403);
      if (!(request.headers.get('Content-Type') || '').startsWith('application/x-www-form-urlencoded')) return json({ error: 'invalid_form' }, 415);
      const form = new URLSearchParams(await bodyText(request));
      const handle = form.get('handle') || '';
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const password = form.get('password') || '';
      if (password.length > 512 || !await equalSecret(password, env.OWNER_PASSWORD)) {
        // Consume this browser-bound attempt as well; a fresh consent page is needed to retry.
        const denied = await oauth.denyConsent(request, handle, { description: 'Authentication failed. Start the connection again.' });
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = form.getAll('scope');
      if (scope.some(s => !SCOPES.includes(s)) || !scope.includes('devices:read')) return json({ error: 'invalid_scope' }, 400);
      const approved = await oauth.approveConsent(request, handle, { scope });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, userId: 'owner', metadata: { service: 'switchbot-control' },
        scope: approved.request.scope, props: { userId: 'owner' },
      });
      approved.headers.set('Location', redirectTo);
      approved.headers.set('Cache-Control', 'no-store');
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const failure = authorizationFailure(error);
        // Only fixed reason codes are exposed or logged; never OAuth state, cookies,
        // passwords, client metadata URLs, or library exception descriptions.
        console.warn('oauth_authorization_failed', { reason: failure.reason });
        return json({ error: 'authorization_failed', ...failure }, 400);
      }
      throw error;
    }
  },
};

const TOOLS = [
  { name: 'list_devices', description: '登録済みのSwitchBot機器と利用できる操作を取得します。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'get_device_status', description: '登録機器1台の現在の状態を取得します。deviceにはlist_devicesのkeyを指定します。', inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'set_device_power', description: '登録機器1台をON/OFFします。PC用プラグをOFFにする前に、必ずOSを正常終了させてください。APIの受付成功と実際の状態は別です。状態を取得して確認してください。', inputSchema: { type: 'object', properties: { device: { type: 'string' }, power: { type: 'string', enum: ['on', 'off'] }, shutdown_confirmed: { type: 'boolean', description: 'PC用プラグをOFFにするとき、OSの正常終了を確認済みの場合だけtrue。' } }, required: ['device', 'power'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
];

async function switchbot(env, device, action) {
  const timestamp = String(Date.now()), nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', ENCODER.encode(env.SWITCHBOT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, ENCODER.encode(env.SWITCHBOT_TOKEN + timestamp + nonce));
  const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const read = action === 'status';
  const url = `https://api.switch-bot.com/v1.1/devices/${encodeURIComponent(device.id)}/${read ? 'status' : 'commands'}`;
  const response = await fetch(url, {
    method: read ? 'GET' : 'POST',
    headers: { Authorization: env.SWITCHBOT_TOKEN, sign, t: timestamp, nonce, 'Content-Type': 'application/json' },
    ...(read ? {} : { body: JSON.stringify({ command: action === 'on' ? 'turnOn' : 'turnOff', parameter: 'default', commandType: 'command' }) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`SwitchBot HTTP ${response.status}`);
  const data = await response.json();
  if (data.statusCode !== 100) throw new Error(`SwitchBot API ${Number(data.statusCode) || 'error'}`);
  if (!read) return { accepted: true, requestedPower: action };
  const safe = {};
  for (const key of ['power', 'powerState', 'voltage', 'electricCurrent', 'temperature', 'humidity', 'battery', 'version']) {
    const value = data.body?.[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  return { status: safe };
}

const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => json({ jsonrpc: '2.0', id, result });
const toolResult = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

const apiHandler = {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/mcp') return json({ error: 'not_found' }, 404);
    if (ctx.props?.userId !== 'owner' || !ctx.auth?.scope?.includes('devices:read')) return json({ error: 'insufficient_scope' }, 403);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'json_required' }, 415);
    let message;
    try { message = JSON.parse(await bodyText(request)); } catch { return rpcError(null, -32700, 'Invalid JSON'); }
    if (!message || Array.isArray(message) || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid request');
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (!hasId) {
      if (!message.method.startsWith('notifications/')) return json({ error: 'invalid_notification' }, 400);
      return new Response(null, { status: 202, headers: SECURITY_HEADERS });
    }
    const id = message.id;
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid id');
    if (message.method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      const proposed = message.params?.protocolVersion;
      return rpcResult(id, { protocolVersion: supported.includes(proposed) ? proposed : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'switchbot-control', version: VERSION }, instructions: '登録された機器だけを操作します。PC用プラグのOFFはOS正常終了後に実行し、API受付後は状態取得で確認してください。' });
    }
    if (message.method === 'ping') return rpcResult(id, {});
    if (message.method === 'tools/list') return rpcResult(id, { tools: TOOLS });
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    const name = message.params?.name;
    if (!TOOLS.some(tool => tool.name === name)) return rpcError(id, -32602, 'Unknown tool');
    const args = message.params?.arguments ?? {};
    if (!args || Array.isArray(args) || typeof args !== 'object') return rpcError(id, -32602, 'Invalid arguments');
    const allowed = name === 'list_devices' ? [] : name === 'get_device_status' ? ['device'] : ['device', 'power', 'shutdown_confirmed'];
    if (Object.keys(args).some(key => !allowed.includes(key))) return rpcError(id, -32602, 'Unexpected arguments');
    const devices = registry(env);
    if (name === 'list_devices') return rpcResult(id, toolResult({ devices: Object.entries(devices).map(([key, d]) => ({ key, name: d.name, actions: d.actions, requiresShutdown: d.requiresShutdown === true })) }));
    if (typeof args.device !== 'string' || !Object.hasOwn(devices, args.device)) return rpcError(id, -32602, 'Device is not registered');
    const device = devices[args.device];
    const action = name === 'get_device_status' ? 'status' : args.power;
    if (!['status', 'on', 'off'].includes(action) || (name === 'set_device_power' && !['on', 'off'].includes(action)) || !device.actions.includes(action)) return rpcError(id, -32602, 'Action is not allowed for this device');
    if (args.shutdown_confirmed !== undefined && typeof args.shutdown_confirmed !== 'boolean') return rpcError(id, -32602, 'Invalid shutdown_confirmed');
    if (name === 'set_device_power' && !ctx.auth.scope.includes('devices:control')) return rpcResult(id, toolResult({ error: 'この接続には電源操作の権限がありません。' }, true));
    if (action === 'off' && device.requiresShutdown && args.shutdown_confirmed !== true) return rpcResult(id, toolResult({ error: 'PCのOSを正常終了させ、停止を確認してからshutdown_confirmed=trueで実行してください。' }, true));
    try {
      return rpcResult(id, toolResult({ device: args.device, name: device.name, ...await switchbot(env, device, action) }));
    } catch (error) {
      const message = /^SwitchBot (HTTP|API) /.test(error.message) ? error.message : 'SwitchBotへの接続に失敗しました。実際の機器の状態を確認してください。';
      return rpcResult(id, toolResult({ error: message }, true));
    }
  },
};

const provider = new OAuthProvider({
  apiRoute: '/mcp', apiHandler, defaultHandler,
  authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  resourceMetadata: { resource: PRODUCTION_ORIGIN + '/mcp', authorization_servers: [PRODUCTION_ORIGIN] },
  scopesSupported: SCOPES, requiredScopes: ['devices:read'],
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600, refreshTokenTTL: 2592000, clientRegistrationTTL: 2592000,
  onError: () => undefined,
});

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.origin !== PRODUCTION_ORIGIN) return json({ error: 'use_production_url', url: PRODUCTION_ORIGIN }, 400);
      const missing = missingSettings(env);
      if (url.pathname === '/' || url.pathname === '/health') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return json({ service: 'switchbot-control', version: VERSION, ready: missing.length === 0, missing, mcp: PRODUCTION_ORIGIN + '/mcp' });
      }
      if (missing.length) return json({ error: 'setup_required', missing }, 503);
      const origin = request.headers.get('Origin');
      if (url.pathname.startsWith('/mcp') && origin && origin !== PRODUCTION_ORIGIN) return json({ error: 'invalid_origin' }, 403);
      return await provider.fetch(request, env, ctx);
    } catch {
      return json({ error: 'internal_error', message: '設定または接続に問題があります。秘密情報を含むログは出力していません。' }, 500);
    }
  },
};
