// ============================================================================
// ingest-lead de ponta a ponta: o handler de verdade roda contra um PostgREST
// de mentira (tests/functions/lib). Cobre de qual organização é o lead que chega
// pelo formulário da página e com qual contato a função chama o banco.
//
// Ordem para achar a organização: a que a página informa (data-org do snippet,
// slug ou id), depois a do código do link de rastreio e, sem nenhum dos dois, a
// organização padrão da instalação, como antes.
//
// Como rodar:
//   npm run test:functions:e2e
// ============================================================================

import assert from 'node:assert/strict';
import { loadEdgeHandler, type Row, TEST_ENV } from './lib/fake-backend.ts';
import { newScenario, type Scenario } from './lib/scenario.ts';

const handler = await loadEdgeHandler(
  new URL('../../supabase/functions/ingest-lead/index.ts', import.meta.url).href,
);

function scenarioTest(name: string, fn: (s: Scenario) => Promise<void>): void {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const s = await newScenario();
      try {
        await fn(s);
      } finally {
        s.done();
      }
    },
  });
}

async function send(body: unknown): Promise<{ status: number; body: Row }> {
  const res = await handler(new Request(`${TEST_ENV.SUPABASE_URL}/functions/v1/ingest-lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://landing.exemplo.com' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Row };
}

// Uma segunda organização ativa, criada depois da principal.
function addOrg(s: Scenario, slug: string, status = 'active'): string {
  const id = crypto.randomUUID();
  s.backend.seed('organizations', { id, name: slug, slug, status, created_at: new Date().toISOString() });
  return id;
}

const landingCalls = (s: Scenario) => s.backend.rpcCalls.filter((c) => c.fn === 'ingest_landing_lead');
const contactsByPhone = (s: Scenario, phone: string) => s.backend.rows('contacts').filter((c) => c.phone === phone);

scenarioTest('uma organização só: o lead novo nasce na organização da instalação', async (s) => {
  const res = await send({ name: 'Lia Moura', phone: '5511990000030', utm_source: 'instagram' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [contato] = contactsByPhone(s, '+5511990000030');
  assert.ok(contato, 'contato não foi criado');
  assert.equal(contato.org_id, s.orgId);
  assert.equal(landingCalls(s).length, 1);
  assert.equal(landingCalls(s)[0].args.p_contact_id, contato.id);
});

scenarioTest('várias organizações: o slug informado pela página decide a organização', async (s) => {
  const orgB = addOrg(s, 'clinica-b');
  const res = await send({ name: 'Rui Sales', phone: '5511990000031', org: 'clinica-b' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [contato] = contactsByPhone(s, '+5511990000031');
  assert.equal(contato?.org_id, orgB);
  assert.equal(landingCalls(s)[0]?.args.p_contact_id, contato?.id);
});

scenarioTest('várias organizações: o id informado pela página também vale', async (s) => {
  const orgB = addOrg(s, 'clinica-b');
  const res = await send({ phone: '5511990000032', org: orgB });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(contactsByPhone(s, '+5511990000032')[0]?.org_id, orgB);
});

scenarioTest('várias organizações: o código do link de rastreio decide a organização', async (s) => {
  const orgB = addOrg(s, 'clinica-b');
  s.backend.seed('tracking_sessions', {
    id: crypto.randomUUID(), org_id: orgB, short_code: 'LINKB2', created_at: new Date().toISOString(),
  });
  const res = await send({ phone: '5511990000033', short_code: 'linkb2' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(contactsByPhone(s, '+5511990000033')[0]?.org_id, orgB);
});

scenarioTest('a organização informada pela página vale mais que o código do link', async (s) => {
  const orgB = addOrg(s, 'clinica-b');
  s.backend.seed('tracking_sessions', {
    id: crypto.randomUUID(), org_id: orgB, short_code: 'LINKB3', created_at: new Date().toISOString(),
  });
  const principal = s.backend.rows('organizations').find((o) => o.id === s.orgId)!;
  const res = await send({ phone: '5511990000034', short_code: 'LINKB3', org: principal.slug });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(contactsByPhone(s, '+5511990000034')[0]?.org_id, s.orgId);
});

scenarioTest('várias organizações sem indicação: o lead vai para a organização padrão, como antes', async (s) => {
  addOrg(s, 'clinica-b');
  const res = await send({ phone: '5511990000035' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(contactsByPhone(s, '+5511990000035')[0]?.org_id, s.orgId);
});

scenarioTest('organização informada que não existe: recusa sem criar contato', async (s) => {
  addOrg(s, 'clinica-b');
  const res = await send({ phone: '5511990000036', org: 'nao-existe' });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /organiza/i);
  assert.equal(contactsByPhone(s, '+5511990000036').length, 0);
  assert.equal(landingCalls(s).length, 0);
});

scenarioTest('organização arquivada: recusa sem criar contato', async (s) => {
  addOrg(s, 'antiga', 'archived');
  const res = await send({ phone: '5511990000037', org: 'antiga' });
  assert.equal(res.status, 400);
  assert.equal(contactsByPhone(s, '+5511990000037').length, 0);
});

scenarioTest('mesmo telefone em duas organizações: usa o contato da organização certa', async (s) => {
  const orgB = addOrg(s, 'clinica-b');
  const doA = crypto.randomUUID();
  const doB = crypto.randomUUID();
  s.backend.seed('contacts', [
    { id: doA, org_id: s.orgId, phone: '+5511990000038', name: 'Teo na A' },
    { id: doB, org_id: orgB, phone: '+5511990000038', name: 'Teo na B' },
  ]);
  const res = await send({ phone: '5511990000038', org: 'clinica-b' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(contactsByPhone(s, '+5511990000038').length, 2, 'não pode criar contato novo');
  assert.equal(landingCalls(s)[0]?.args.p_contact_id, doB);
});
