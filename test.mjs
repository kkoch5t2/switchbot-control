import assert from 'node:assert/strict';
const { default: worker } = await import(process.env.WORKER_FILE || './src.mjs');
import { createHash, createHmac } from 'node:crypto';

class MemoryKV {
  values = new Map();
  async put(key, value, opts = {}) { this.values.set(key, { value, metadata: opts.metadata }); }
  async get(key, opts) { const v = this.values.get(key)?.value; return v === undefined ? null : (opts === 'json' || opts?.type === 'json') ? JSON.parse(v) : v; }
  async getWithMetadata(key, opts) { return { value: await this.get(key, opts), metadata: this.values.get(key)?.metadata || null }; }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.values].filter(([key]) => key.startsWith(prefix)).map(([name, value]) => ({ name, metadata: value.metadata })), list_complete: true, cursor: '' }; }
}
const ORIGIN = 'https://switchbot-control.example.com';
const env = {
  SWITCHBOT_TOKEN: 'test-switchbot-token', SWITCHBOT_SECRET: 'test-switchbot-secret',
  OWNER_PASSWORD: 'test-only-owner-password-long-enough',
  DEVICES_JSON: JSON.stringify({ chuwi: { name: 'CHUWI電源', id: 'TEST_DEVICE_1', actions: ['status', 'on', 'off'], requiresShutdown: true }, lamp: { name: 'テスト照明', id: 'TEST_DEVICE_2', actions: ['status', 'on', 'off'] } }),
  OAUTH_KV: new MemoryKV(),
};
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const call = (path, init, config = env) => worker.fetch(new Request(ORIGIN + path, init), config, ctx());
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let r = await call('/health');
assert.equal((await r.json()).ready, true);
r = await call('/health', {}, { ...env, OWNER_PASSWORD: 'short' });
assert.equal((await r.json()).ready, false);
r = await call('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
assert.equal(r.status, 401);
assert.ok(r.headers.get('www-authenticate'));
r = await call('/.well-known/oauth-authorization-server');
assert.equal(r.status, 200);
assert.equal((await r.json()).token_endpoint, ORIGIN + '/oauth/token');
r = await call('/oauth/register', post({ client_name: 'Local test client', redirect_uris: ['https://example.com/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }));
const client = await r.json();
assert.ok(client.client_id, JSON.stringify(client));
const verifier = 'test-pkce-verifier-' + 'q'.repeat(40);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authPath = '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://example.com/callback', state: 'test-state', code_challenge: challenge, code_challenge_method: 'S256', scope: 'devices:read devices:control offline_access', resource: ORIGIN + '/mcp' });
async function consent() {
  const response = await call(authPath);
  const html = await response.text();
  assert.equal(response.status, 200, html);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin', 'Native consent forms must retain their Origin');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://example.com; base-uri 'none'; frame-ancestors 'none'", 'Consent must allow the registered callback origin for browser POST redirects');
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { handle, cookie, html };
}
const authorize = (page, password, cookie = page.cookie) => call('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: cookie || '' }, body: new URLSearchParams([['handle', page.handle], ['password', password], ['decision', 'approve'], ['scope', 'devices:read'], ['scope', 'devices:control'], ['scope', 'offline_access']]) });
let page = await consent();
assert.ok(page.html.includes('example.com'));
for (const origin of ['null', 'https://attacker.example']) {
  const rejected = await call('/authorize', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(rejected.status, 403, 'Untrusted consent origins must still fail');
  assert.equal((await rejected.json()).error, 'invalid_origin');
}
const missingCookie = await authorize(page, env.OWNER_PASSWORD, '');
assert.equal(missingCookie.status, 400, 'Missing browser binding must fail');
assert.equal((await missingCookie.json()).reason, 'consent_cookie_missing');
page = await consent();
r = await authorize(page, 'wrong-password');
assert.equal(r.status, 302);
assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'access_denied');
page = await consent();
r = await authorize(page, env.OWNER_PASSWORD);
assert.equal(r.status, 302, await r.clone().text());
const callback = new URL(r.headers.get('location'));
assert.equal(callback.searchParams.get('state'), 'test-state');
const code = callback.searchParams.get('code');
assert.ok(code);
const reusedConsent = await authorize(page, env.OWNER_PASSWORD);
assert.equal(reusedConsent.status, 400, 'Consent cannot be reused');
assert.equal((await reusedConsent.json()).reason, 'consent_expired_or_used');
const exchange = (pkce = verifier) => call('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: 'https://example.com/callback', code_verifier: pkce, resource: ORIGIN + '/mcp' }) });
r = await exchange();
const token = await r.json();
assert.ok(token.access_token, JSON.stringify(token));
assert.ok(token.refresh_token);
const rpc = async (method, params, extra = {}) => {
  const init = post({ jsonrpc: '2.0', id: 7, method, params });
  init.headers.Authorization = `Bearer ${token.access_token}`;
  Object.assign(init.headers, extra);
  const response = await call('/mcp', init);
  return { status: response.status, data: await response.json() };
};
let result = await rpc('initialize', { protocolVersion: '2025-03-26' });
assert.equal(result.data.result?.protocolVersion, '2025-03-26', JSON.stringify(result));
result = await rpc('tools/list');
assert.equal(result.data.result.tools.length, 3);
result = await rpc('tools/call', { name: 'list_devices', arguments: {} });
const listed = JSON.parse(result.data.result.content[0].text);
assert.equal(listed.devices.length, 2);
assert.ok(!JSON.stringify(result.data).includes('TEST_DEVICE_1'), 'Device IDs must stay private');
assert.equal((await rpc('tools/list', {}, { Origin: 'https://attacker.example' })).status, 403);
let requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.ok(url.startsWith('https://api.switch-bot.com/v1.1/devices/'));
  const h = init.headers;
  assert.equal(h.Authorization, env.SWITCHBOT_TOKEN);
  assert.equal(h.sign, createHmac('sha256', env.SWITCHBOT_SECRET).update(h.Authorization + h.t + h.nonce).digest('base64'));
  requests.push({ url, ...init });
  return Response.json({ statusCode: 100, body: { deviceId: 'PRIVATE_ID', power: 'off', version: 'test' } });
};
result = await rpc('tools/call', { name: 'set_device_power', arguments: { device: 'chuwi', power: 'off' } });
assert.equal(result.data.result.isError, true);
assert.equal(requests.length, 0);
result = await rpc('tools/call', { name: 'set_device_power', arguments: { device: 'unknown', power: 'on' } });
assert.equal(result.data.error.code, -32602);
assert.equal(requests.length, 0);
result = await rpc('tools/call', { name: 'set_device_power', arguments: { device: 'chuwi', power: 'off', shutdown_confirmed: true } });
assert.equal(JSON.parse(result.data.result.content[0].text).accepted, true);
assert.ok(requests[0].url.includes('TEST_DEVICE_1/commands'));
assert.equal(JSON.parse(requests[0].body).command, 'turnOff');
result = await rpc('tools/call', { name: 'set_device_power', arguments: { device: 'lamp', power: 'on' } });
assert.ok(requests[1].url.includes('TEST_DEVICE_2/commands'));
assert.equal(JSON.parse(requests[1].body).command, 'turnOn');
result = await rpc('tools/call', { name: 'get_device_status', arguments: { device: 'chuwi' } });
assert.equal(JSON.parse(result.data.result.content[0].text).status.power, 'off');
assert.ok(!JSON.stringify(result.data).includes('PRIVATE_ID'));
globalThis.fetch = async () => { throw new Error('sensitive-token-must-not-leak'); };
result = await rpc('tools/call', { name: 'get_device_status', arguments: { device: 'lamp' } });
assert.equal(result.data.result.isError, true);
assert.ok(!JSON.stringify(result.data).includes('sensitive-token'));
globalThis.fetch = realFetch;
assert.notEqual((await exchange()).status, 200, 'Authorization code cannot be exchanged twice');
console.log('PASS: OAuth discovery, PKCE, owner authentication, browser-bound consent, code/consent replay rejection, MCP, device routing, shutdown guard, SwitchBot signing, secret filtering. No live devices contacted.');
