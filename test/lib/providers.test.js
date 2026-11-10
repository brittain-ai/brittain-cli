'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSettings } = require('../../src/lib/settings');
const { createProviders } = require('../../src/lib/providers');
const brittain = require('../../src/lib/providers/brittain');
const { createFakeProvider } = require('../helpers/fake-provider');

function providersWith({ settings = {}, keys = {}, env = {} } = {}) {
  const secrets = { get: (name) => keys[name] || '' };
  return createProviders({ getSettings: () => normalizeSettings(settings), secrets, env });
}

test('the Brittain endpoint lives in one constant and is overridable only by env', () => {
  assert.equal(brittain.brittainEndpoint({}), brittain.BRITTAIN_ENDPOINT);
  assert.equal(brittain.brittainEndpoint({ BRITTAIN_API_URL: 'http://127.0.0.1:1/x/' }), 'http://127.0.0.1:1/x');
  assert.ok(['openai', 'ollama'].includes(brittain.BRITTAIN_TRANSPORT));
});

test('describe() never includes the Brittain endpoint or any key', () => {
  const env = { BRITTAIN_API_URL: 'https://secret-host.example.test/hidden/v1' };
  const providers = providersWith({ keys: { brittainApiKey: 'bk-123', openaiApiKey: 'sk-456' }, env });
  const described = JSON.stringify(['brittain', 'openai', 'ollama'].map((mode) => providers.describe(mode)));
  for (const leak of ['secret-host', 'hidden', 'bk-123', 'sk-456']) assert.equal(described.includes(leak), false, leak);
  assert.equal(providers.describe('brittain').keySet, true);
});

test('Brittain mode sends its key as the configured auth header, and none without a key', () => {
  const withKey = providersWith({ keys: { brittainApiKey: 'bk-1' } }).resolve('brittain');
  assert.deepEqual(withKey.extraHeaders, { [brittain.AUTH_HEADER]: `${brittain.AUTH_SCHEME} bk-1` });
  assert.equal(withKey.apiKey, '');
  assert.deepEqual(providersWith().resolve('brittain').extraHeaders, {});
  assert.equal(providersWith().resolve('brittain').model, 'run4c-step-0116');
  assert.equal(providersWith().resolve('brittain').defaultContext, 32_768);
});

test('each mode resolves to its own transport and endpoint', () => {
  const providers = providersWith({
    settings: { providers: { openai: { endpoint: 'https://openrouter.ai/api/v1', model: 'm' }, ollama: { model: 'q' } } },
    keys: { openaiApiKey: 'sk-1' },
  });
  const openai = providers.resolve('openai');
  assert.equal(openai.transport.id, 'openai');
  assert.equal(openai.apiKey, 'sk-1');
  const ollama = providers.resolve('ollama');
  assert.equal(ollama.transport.id, 'ollama');
  assert.equal(ollama.endpoint, 'http://127.0.0.1:11434');
  assert.equal(ollama.apiKey, '');
});

test('Brittain errors are redacted before they leave the provider layer', async (t) => {
  const failing = await createFakeProvider({ prefix: '/hidden-path-91', status: 502 }).start();
  t.after(() => failing.stop());
  for (const url of [`${failing.base}/v1`, 'http://hidden-host-91.invalid:5151/v1']) {
    const providers = providersWith({ env: { BRITTAIN_API_URL: url } });
    const result = await providers.listModels('brittain', { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    for (const leak of ['hidden-path-91', 'hidden-host-91', String(failing.port), '5151']) {
      assert.equal(result.error.includes(leak), false, `${leak} in: ${result.error}`);
    }
  }
});

test('redaction leaves generic API paths in ordinary text alone', () => {
  const env = { BRITTAIN_API_URL: 'https://api.brittain.example/v1' };
  assert.equal(brittain.redactEndpoint('GET /v1/models failed', env), 'GET /v1/models failed');
  assert.equal(brittain.redactEndpoint('at https://api.brittain.example/v1/chat', env), 'at the Brittain API/chat');
});
