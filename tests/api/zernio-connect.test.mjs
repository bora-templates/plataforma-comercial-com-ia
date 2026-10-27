// ============================================================================
// Conexão da Zernio com Instagram (src/lib/zernio-connect-flow.ts)
// ----------------------------------------------------------------------------
// O api/zernio-connect listava só as contas de WhatsApp. Quem tinha só
// Instagram na Zernio recebia "Nenhuma conta WhatsApp encontrada" e o webhook
// nunca era cadastrado. E, com WhatsApp, o id da conta de Instagram não ficava
// guardado em lugar nenhum, então o zernio-webhook não achava a organização da
// DM quando havia mais de uma ativa.
//
// Aqui o fluxo roda com o cliente HTTP de verdade (src/lib/zernio.ts) contra um
// fetch falso que imita a API da Zernio, com o cofre de credenciais em memória.
// Nenhuma chamada sai da máquina.
//
// Como rodar (Node 22.18+, que importa o TypeScript direto):
//   npm run test:api
// ============================================================================

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const zernio = await import('../../src/lib/zernio.ts').catch(() => null);
const flow = await import('../../src/lib/zernio-connect-flow.ts').catch(() => null);
const skip = zernio && flow ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// API da Zernio de mentira: GET /accounts, GET /profiles, GET number-info e
// POST /webhooks/settings. Guarda cada chamada para o teste conferir.
function fakeZernio(accounts, { profiles = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: pathname, body: init.body ? JSON.parse(init.body) : null });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET' && pathname.endsWith('/accounts')) return json({ accounts });
    if (method === 'GET' && pathname.endsWith('/profiles')) return json({ profiles });
    if (method === 'GET' && pathname.endsWith('/whatsapp/number-info')) {
      return json({ phone: { display_phone_number: '+55 11 99000-0001', verified_name: 'Escola Contraluz', status: 'CONNECTED' } });
    }
    if (method === 'POST' && pathname.endsWith('/webhooks/settings')) return json({ success: true });
    return new Response('not found', { status: 404 });
  };
  return calls;
}

function setup({ credentials = {}, chosenId } = {}) {
  const vault = { zernio_api_key: 'chave-de-teste', ...credentials };
  const channels = [];
  const deps = {
    getCredential: async (key) => vault[key] ?? null,
    setCredential: async (key, value) => {
      vault[key] = value;
    },
    listAccounts: zernio.listZernioAccounts,
    resolveProfileId: zernio.resolveProfileId,
    getNumberInfo: zernio.getNumberInfo,
    registerWebhook: zernio.registerWebhook,
    syncChannel: async (account) => {
      channels.push(account.id);
      return { channelId: `canal-${account.id}` };
    },
    webhookUrl: () => 'https://projeto.supabase.co/functions/v1/zernio-webhook',
    newSecret: () => 'segredo-novo',
  };
  return { vault, channels, run: () => flow.runZernioConnect(deps, { chosenId: chosenId ?? '' }) };
}

const whatsapp = (id, profile = 'perfil-1') => ({ _id: id, platform: 'whatsapp', displayName: 'Escola Contraluz', profileId: { _id: profile, name: 'Contraluz' } });
const instagram = (id, username, profile = 'perfil-1') => ({ _id: id, platform: 'instagram', username, displayName: `Nome ${username}`, profileId: { _id: profile } });

test('conta só com Instagram: conecta, cadastra o webhook e avisa que não achou WhatsApp', { skip }, async () => {
  const calls = fakeZernio([instagram('ig-1', 'escolacontraluz', 'perfil-ig')]);
  const { vault, channels, run } = setup();

  const result = await run();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.match(result.body.message, /nenhum número de WhatsApp/i);
  assert.match(result.body.message, /Instagram/);
  assert.deepEqual(result.body.instagram.accounts, [{ id: 'ig-1', username: 'escolacontraluz' }]);
  assert.equal(result.body.accountId, null);

  const webhook = calls.find((c) => c.method === 'POST' && c.path.endsWith('/webhooks/settings'));
  assert.ok(webhook, 'o webhook precisa ser cadastrado');
  assert.equal(webhook.body.url, 'https://projeto.supabase.co/functions/v1/zernio-webhook');
  assert.equal(webhook.body.secret, 'segredo-novo');

  assert.deepEqual(JSON.parse(vault.zernio_instagram_account_ids), ['ig-1']);
  assert.equal(vault.zernio_profile_id, 'perfil-ig');
  assert.equal(vault.zernio_webhook_secret, 'segredo-novo');
  assert.equal(vault.zernio_account_id, undefined, 'sem WhatsApp, o número não é tocado');
  assert.deepEqual(channels, [], 'sem WhatsApp, nenhum canal novo');
  assert.ok(!calls.some((c) => c.path.endsWith('/whatsapp/number-info')));
});

test('WhatsApp e Instagram: conecta o número e guarda a conta de Instagram', { skip }, async () => {
  fakeZernio([whatsapp('wa-1'), instagram('ig-1', 'escolacontraluz'), instagram('ig-2', 'contraluz.cursos')]);
  const { vault, channels, run } = setup({ credentials: { zernio_webhook_secret: 'segredo-antigo' } });

  const result = await run();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.accountId, 'wa-1');
  assert.equal(vault.zernio_account_id, 'wa-1');
  assert.equal(vault.zernio_profile_id, 'perfil-1');
  assert.equal(vault.zernio_webhook_secret, 'segredo-antigo', 'segredo existente é reaproveitado');
  assert.deepEqual(JSON.parse(vault.zernio_instagram_account_ids), ['ig-1', 'ig-2']);
  assert.deepEqual(result.body.instagram.accounts.map((a) => a.username), ['escolacontraluz', 'contraluz.cursos']);
  assert.deepEqual(channels, ['wa-1']);
});

test('Instagram desconectado no painel: a sincronização esvazia a lista guardada', { skip }, async () => {
  fakeZernio([whatsapp('wa-1')]);
  const { vault, run } = setup({ credentials: { zernio_instagram_account_ids: '["ig-velho"]' } });

  const result = await run();

  assert.equal(result.body.success, true);
  assert.deepEqual(JSON.parse(vault.zernio_instagram_account_ids), []);
  assert.equal(result.body.instagram.connected, false);
});

test('duas contas de WhatsApp: pede a escolha, mas já guarda o Instagram', { skip }, async () => {
  const calls = fakeZernio([whatsapp('wa-1'), whatsapp('wa-2'), instagram('ig-1', 'escolacontraluz')]);
  const { vault, run } = setup();

  const result = await run();

  assert.equal(result.body.needsSelection, true);
  assert.deepEqual(result.body.accounts.map((a) => a.id), ['wa-1', 'wa-2']);
  assert.deepEqual(JSON.parse(vault.zernio_instagram_account_ids), ['ig-1']);
  assert.ok(!calls.some((c) => c.path.endsWith('/webhooks/settings')));
});

test('conta sem WhatsApp e sem Instagram: erro claro', { skip }, async () => {
  fakeZernio([{ _id: 'tt-1', platform: 'tiktok', username: 'x' }]);
  const { run } = setup();

  const result = await run();

  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.match(result.body.message, /WhatsApp ou Instagram/);
});

test('sem a API Key salva: pede para salvar antes', { skip }, async () => {
  fakeZernio([]);
  const { vault, run } = setup();
  delete vault.zernio_api_key;

  const result = await run();

  assert.equal(result.status, 400);
  assert.match(result.body.message, /Salve a Zernio API Key/);
});

test('instagramStatus lê a lista guardada para a tela', { skip }, () => {
  assert.deepEqual(flow.instagramStatus(null, null), { connected: false, accounts: [] });
  assert.deepEqual(
    flow.instagramStatus('["ig-1"]', '[{"id":"ig-1","username":"escolacontraluz"}]'),
    { connected: true, accounts: [{ id: 'ig-1', username: 'escolacontraluz' }] },
  );
  assert.deepEqual(flow.instagramStatus('["ig-1"]', 'lixo'), { connected: true, accounts: [{ id: 'ig-1', username: null }] });
});
