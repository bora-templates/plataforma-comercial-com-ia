// ============================================================================
// Organização dona de um evento da Zernio (supabase/functions/_shared/zernio-org.ts)
// ----------------------------------------------------------------------------
// O webhook da Zernio é cadastrado sem ?org=. Com uma organização ativa, ela é
// a dona. Com mais de uma, a dona sai da conta citada no evento. A DM do
// Instagram chega com o accountId da conta de Instagram, que não é o número de
// WhatsApp guardado em zernio_account_id, e por isso era descartada (no_org).
// Agora a busca também olha a lista de contas de Instagram da organização
// (zernio_instagram_account_ids) e, por último, o perfil Zernio
// (zernio_profile_id, só quando zernio_profile_confirmed = 'true') contra
// profiles[].id do evento.
//
// Como rodar (Node 22.18+, que importa o TypeScript direto):
//   npm run test:functions
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../supabase/functions/_shared/zernio-org.ts').catch(() => null);
const skip = mod ? false : 'este Node não importa TypeScript direto (precisa de 22.18+)';

// Instalação de mentira: organizações, canais e credenciais em memória.
function install({ orgs, channels = {}, credentials = {} }) {
  const logs = [];
  const lookup = {
    async findOrg(id) {
      return orgs.find((org) => org.id === id) ?? null;
    },
    async activeOrgs() {
      return orgs.filter((org) => org.status === 'active');
    },
    async channelOrgByAccount(accountId) {
      return channels[accountId] ?? null;
    },
    async credential(orgId, key) {
      return credentials[orgId]?.[key] ?? null;
    },
    log(entry) {
      logs.push(entry);
    },
  };
  return { lookup, logs };
}

const DUAS = [
  { id: 'org-a', status: 'active' },
  { id: 'org-b', status: 'active' },
];

// Formato documentado da Zernio para a DM do Instagram.
const dmInstagram = (accountId, profileId = 'perfil-x') => ({
  id: 'evt-1',
  type: 'message.received',
  profiles: [{ id: profileId, externalId: 'cliente-externo' }],
  account: { accountId, platform: 'instagram' },
  message: { id: 'msg-1', platform: 'instagram', sender: { id: 'igsid-1' } },
});

test('o accountId do evento sai de account.accountId e de account.id', { skip }, () => {
  assert.equal(mod.zernioEventAccountId(dmInstagram('ig-1')), 'ig-1');
  assert.equal(mod.zernioEventAccountId({ account: { id: 'wa-1' } }), 'wa-1');
  assert.equal(mod.zernioEventAccountId({ data: { account: { accountId: 'ig-2' } } }), 'ig-2');
  assert.equal(mod.zernioEventAccountId({ message: { accountId: 'wa-2' } }), 'wa-2');
  assert.equal(mod.zernioEventAccountId(null), null);
});

test('os ids de perfil saem de profiles[].id, no topo ou dentro de data', { skip }, () => {
  assert.deepEqual(mod.zernioEventProfileIds(dmInstagram('ig-1', 'p-1')), ['p-1']);
  assert.deepEqual(mod.zernioEventProfileIds({ data: { profiles: [{ id: 'p-2' }, { _id: 'p-3' }] } }), ['p-2', 'p-3']);
  assert.deepEqual(mod.zernioEventProfileIds({ profiles: 'lixo' }), []);
});

test('duas organizações ativas: a DM do Instagram vai para a dona da conta de Instagram', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_account_id: 'wa-a', zernio_instagram_account_ids: '["ig-a"]' },
      'org-b': { zernio_account_id: 'wa-b', zernio_instagram_account_ids: '["ig-b1","ig-b2"]' },
    },
  });
  const evento = dmInstagram('ig-b2');
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null,
    accountId: mod.zernioEventAccountId(evento),
    profileIds: mod.zernioEventProfileIds(evento),
  });
  assert.deepEqual(found, { orgId: 'org-b', status: 'active' });
});

test('duas organizações ativas: sem conta conhecida, o perfil Zernio do evento acha a dona', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_account_id: 'wa-a', zernio_profile_id: 'perfil-a', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_account_id: 'wa-b', zernio_profile_id: 'perfil-b', zernio_profile_confirmed: 'true' },
    },
  });
  const evento = dmInstagram('ig-nunca-sincronizada', 'perfil-a');
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null,
    accountId: mod.zernioEventAccountId(evento),
    profileIds: mod.zernioEventProfileIds(evento),
  });
  assert.deepEqual(found, { orgId: 'org-a', status: 'active' });
});

test('duas organizações donas da mesma conta de Instagram: descarta e registra o motivo', { skip }, async () => {
  const { lookup, logs } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_instagram_account_ids: '["ig-1"]', zernio_profile_id: 'perfil-a', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_instagram_account_ids: '["ig-1"]', zernio_profile_id: 'perfil-b', zernio_profile_confirmed: 'true' },
    },
  });
  // Evento sem profiles[]: a defesa por perfil não decide, e as duas são donas.
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null, accountId: 'ig-1', profileIds: [],
  });
  assert.equal(found, null);
  assert.ok(logs.some((entry) => entry.event === 'zernio_webhook_ambiguous_org'));
  // Com o perfil no evento, só a organização do mesmo perfil fica.
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-1', profileIds: ['perfil-a'] }),
    { orgId: 'org-a', status: 'active' },
  );
});

test('duas organizações com o mesmo perfil Zernio e conta desconhecida: descarta', { skip }, async () => {
  const { lookup, logs } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_profile_id: 'perfil-x', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_profile_id: 'perfil-x', zernio_profile_confirmed: 'true' },
    },
  });
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null, accountId: 'ig-1', profileIds: ['perfil-x'],
  });
  assert.equal(found, null);
  assert.ok(logs.some((entry) => entry.event === 'zernio_webhook_ambiguous_org'));
});

test('duas organizações e nenhuma dona: descarta', { skip }, async () => {
  const { lookup } = install({ orgs: DUAS, credentials: { 'org-a': { zernio_account_id: 'wa-a' } } });
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null, accountId: 'ig-1', profileIds: ['perfil-z'],
  });
  assert.equal(found, null);
});

test('o canal e o número de WhatsApp continuam valendo antes do Instagram', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    channels: { 'wa-canal': 'org-b' },
    credentials: {
      'org-a': { zernio_account_id: 'wa-a', zernio_profile_id: 'perfil-comum', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_profile_id: 'perfil-comum', zernio_profile_confirmed: 'true' },
    },
  });
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'wa-canal', profileIds: ['perfil-comum'] }),
    { orgId: 'org-b', status: 'active' },
  );
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'wa-a', profileIds: ['perfil-comum'] }),
    { orgId: 'org-a', status: 'active' },
  );
});

test('lista de Instagram ilegível não derruba a busca', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_instagram_account_ids: 'não é json' },
      'org-b': { zernio_instagram_account_ids: '["ig-1"]' },
    },
  });
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-1', profileIds: [] }),
    { orgId: 'org-b', status: 'active' },
  );
});

test('uma organização ativa só: continua sendo a dona, sem olhar a conta', { skip }, async () => {
  const { lookup } = install({ orgs: [{ id: 'org-a', status: 'active' }, { id: 'org-v', status: 'archived' }] });
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: null, profileIds: [] }),
    { orgId: 'org-a', status: 'active' },
  );
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-qualquer', profileIds: [] }),
    { orgId: 'org-a', status: 'active' },
  );
});

test('?org= na URL continua decidindo, inclusive organização arquivada', { skip }, async () => {
  const { lookup } = install({ orgs: [...DUAS, { id: 'org-v', status: 'archived' }] });
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: 'org-v', accountId: 'ig-1', profileIds: [] }),
    { orgId: 'org-v', status: 'archived' },
  );
  assert.equal(await mod.resolveZernioOrg(lookup, { orgFromQuery: 'nao-existe', accountId: null, profileIds: [] }), null);
});

test('defesa: conta de Instagram na lista, mas o evento é de outro perfil Zernio, não roteia', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      // Lista gravada errada (versão antiga guardava todas as contas da chave).
      'org-a': { zernio_instagram_account_ids: '["ig-b"]', zernio_profile_id: 'perfil-a', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_profile_id: 'perfil-b', zernio_profile_confirmed: 'true' },
    },
  });
  const evento = dmInstagram('ig-b', 'perfil-b');
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null,
    accountId: mod.zernioEventAccountId(evento),
    profileIds: mod.zernioEventProfileIds(evento),
  });
  // org-a é descartada no passo do Instagram; o passo do perfil acha a dona certa.
  assert.deepEqual(found, { orgId: 'org-b', status: 'active' });
});

test('defesa: perfil diferente e nenhuma outra dona, o evento é descartado', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_instagram_account_ids: '["ig-c"]', zernio_profile_id: 'perfil-a', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_profile_id: 'perfil-b', zernio_profile_confirmed: 'true' },
    },
  });
  const found = await mod.resolveZernioOrg(lookup, {
    orgFromQuery: null, accountId: 'ig-c', profileIds: ['perfil-c'],
  });
  assert.equal(found, null);
});

test('defesa: organização sem zernio_profile_id ou evento sem profiles continua achando pela lista', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: { 'org-a': { zernio_instagram_account_ids: '["ig-a"]' }, 'org-b': {} },
  });
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-a', profileIds: ['perfil-qualquer'] }),
    { orgId: 'org-a', status: 'active' },
  );
});

test('perfil não confirmado (veio do primeiro perfil da lista) não roteia DM', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_account_id: 'wa-a', zernio_profile_id: 'perfil-a', zernio_profile_confirmed: 'true' },
      'org-b': { zernio_account_id: 'wa-b', zernio_profile_id: 'perfil-x', zernio_profile_confirmed: 'false' },
    },
  });
  assert.equal(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-x', profileIds: ['perfil-x'] }),
    null,
  );
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-a', profileIds: ['perfil-a'] }),
    { orgId: 'org-a', status: 'active' },
  );
});

test('perfil sem a marca de confirmado (instalação antiga) não roteia nem descarta pela defesa', { skip }, async () => {
  const { lookup } = install({
    orgs: DUAS,
    credentials: {
      'org-a': { zernio_profile_id: 'perfil-a' },
      'org-b': { zernio_instagram_account_ids: '["ig-b"]', zernio_profile_id: 'perfil-velho' },
    },
  });
  // Pelo perfil: org-a não confirmou, então ninguém é dono.
  assert.equal(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-z', profileIds: ['perfil-a'] }),
    null,
  );
  // Pela lista: o perfil não confirmado de org-b não derruba a DM legítima.
  assert.deepEqual(
    await mod.resolveZernioOrg(lookup, { orgFromQuery: null, accountId: 'ig-b', profileIds: ['perfil-b'] }),
    { orgId: 'org-b', status: 'active' },
  );
});
