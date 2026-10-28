import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const origin = 'https://switchbot-control.example.com';
const password = 'test-only-password-for-runtime-check-123';
const mf = new Miniflare({
  modules: true, scriptPath: new URL('./worker.js', import.meta.url).pathname,
  compatibilityDate: '2026-08-06', compatibilityFlags: ['global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'],
  bindings: {
    SWITCHBOT_TOKEN: 'test-token', SWITCHBOT_SECRET: 'test-secret', OWNER_PASSWORD: password,
    DEVICES_JSON: JSON.stringify({ chuwi: { name: 'CHUWI電源', id: 'TEST_DEVICE', actions: ['status', 'on', 'off'], requiresShutdown: true } }),
  },
});
try {
  const call = (path, init) => mf.dispatchFetch(origin + path, { ...init, redirect: 'manual' });
  let r = await call('/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ready, true);
  r = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  r = await call('/.well-known/oauth-authorization-server');
  assert.equal(r.status, 200);
  r = await call('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Runtime test', redirect_uris: ['https://example.com/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  const client = await r.json();
  assert.ok(client.client_id, JSON.stringify(client));
  const verifier = 'runtime-verifier-' + 'x'.repeat(48);
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://example.com/callback', state: 'runtime-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'devices:read devices:control offline_access', resource: origin + '/mcp' });
  r = await call('/authorize?' + query);
  const html = await r.text();
  assert.equal(r.status, 200, html);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://example.com; base-uri 'none'; frame-ancestors 'none'");
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await call('/authorize', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['handle', handle], ['password', password], ['decision', 'approve'], ['scope', 'devices:read'], ['scope', 'devices:control'], ['scope', 'offline_access']]).toString() });
  assert.equal(r.status, 302, await r.clone().text());
  const callback = new URL(r.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'runtime-state');
  r = await call('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), client_id: client.client_id, redirect_uri: 'https://example.com/callback', code_verifier: verifier, resource: origin + '/mcp' }).toString() });
  const token = await r.json();
  assert.ok(token.access_token, JSON.stringify(token));
  r = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_devices', arguments: {} } }) });
  const result = await r.json();
  assert.equal(JSON.parse(result.result.content[0].text).devices[0].name, 'CHUWI電源');
  console.log('PASS: Actual workerd runtime compiled the exact delivered bundle; health, unauthenticated rejection, OAuth registration/consent/PKCE/token exchange, authenticated MCP list all passed. No live devices contacted.');
} finally { await mf.dispose(); }
