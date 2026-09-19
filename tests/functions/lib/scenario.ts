// ============================================================================
// Montagem de cenário para os testes de ponta a ponta das Edge Functions.
// Cada teste cria uma conta nova (org_id aleatório), então o cache de
// credenciais de _shared/credentials.ts (60s, por conta) nunca vaza entre testes.
// Datas são sempre relativas ao relógio real, porque o handler usa o relógio real.
// ============================================================================

import { encryptValue } from '../../../supabase/functions/_shared/credentials.ts';
import { applyTestEnv, FakeBackend, type Row, TEST_ENV } from './fake-backend.ts';

applyTestEnv();

const HOUR = 3600 * 1000;
export const hoursAgo = (h: number): string => new Date(Date.now() - h * HOUR).toISOString();
export const daysAgoDate = (d: number): string => hoursAgo(d * 24).slice(0, 10);

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Horário que está aberto agora, qualquer que seja a hora em que o teste roda.
export function hoursOpenNow(): Row {
  return Object.fromEntries(ALL_DAYS.map((d) => [d, { enabled: true, start: '00:00', end: '23:59' }]));
}

// Horário configurado e fechado agora: a janela do dia é um minuto que não é este.
export function hoursClosedNow(): Row {
  const hhmm = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  const nearNoon = hhmm >= '11:55' && hhmm <= '12:05';
  const slot = nearNoon ? { start: '00:00', end: '00:01' } : { start: '12:00', end: '12:01' };
  return Object.fromEntries(ALL_DAYS.map((d) => [d, { enabled: true, ...slot }]));
}

export interface Scenario {
  backend: FakeBackend;
  orgId: string;
  addTemplate(name: string, body: string, patch?: Row): string;
  addRule(patch: Row): string;
  addLead(opts?: {
    name?: string | null;
    phone?: string | null;
    idleHours?: number;
    conversation?: Row;
    // última mensagem pública da conversa; null = conversa sem mensagem
    lastMessage?: 'outbound' | 'inbound' | null;
    privateNoteAfter?: boolean;
  }): { contactId: string; conversationId: string };
  addDeal(contactId: string, patch?: Row): string;
  setBusinessHours(hours: Row, timezone?: string): void;
  done(): void;
}

export async function newScenario(): Promise<Scenario> {
  const backend = new FakeBackend(TEST_ENV.SUPABASE_URL);
  const orgId = crypto.randomUUID();
  backend.seed('organizations', { id: orgId, name: 'Conta de teste', slug: `conta-${orgId}`, status: 'active' });
  backend.seed('public.org_settings', {
    org_id: orgId, key: 'zernio_api_key', value_encrypted: await encryptValue('zernio-key-de-teste'),
  });
  backend.seed('channels', {
    id: crypto.randomUUID(), org_id: orgId, provider: 'zernio', label: 'Oficial', zernio_account_id: 'zacc-1',
    is_active: true, ai_enabled: true, webhook_secret: 's1', created_at: hoursAgo(1000),
  });
  backend.seed('channels', {
    id: crypto.randomUUID(), org_id: orgId, provider: 'uazapi', label: 'Não oficial',
    uazapi_server_url: 'https://instancia.uazapi.test', uazapi_token_encrypted: await encryptValue('token-uazapi'),
    is_active: true, ai_enabled: true, webhook_secret: 's2', created_at: hoursAgo(1000),
  });
  backend.install();

  return {
    backend,
    orgId,
    addTemplate(name, body, patch = {}) {
      const id = crypto.randomUUID();
      backend.seed('templates', { id, org_id: orgId, name, language: 'pt_BR', status: 'approved', body, ...patch });
      return id;
    },
    addRule(patch) {
      const id = crypto.randomUUID();
      backend.seed('follow_up_rules', {
        id, org_id: orgId, campaign_id: null, trigger_condition: 'inactivity', delay_hours: 24, template_id: null,
        sequence_order: 1, is_active: true, provider: 'zernio', message_text: null, params: {},
        created_at: hoursAgo(24 * 30), updated_at: hoursAgo(24 * 30), ...patch,
      });
      return id;
    },
    addLead(opts = {}) {
      const contactId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const idle = opts.idleHours ?? 30;
      backend.seed('contacts', {
        id: contactId, org_id: orgId,
        name: opts.name === undefined ? 'Maria Silva' : opts.name,
        phone: opts.phone === undefined ? `+55119${Math.floor(10000000 + Math.random() * 89999999)}` : opts.phone,
      });
      backend.seed('conversations', {
        id: conversationId, org_id: orgId, contact_id: contactId, status: 'ai_active', ai_paused: false,
        last_message_at: hoursAgo(idle), channel: 'whatsapp', provider: 'zernio',
        zernio_conversation_id: `zconv-existente-${conversationId.slice(0, 8)}`, channel_id: null,
        ...(opts.conversation ?? {}),
      });
      const last = opts.lastMessage === undefined ? 'outbound' : opts.lastMessage;
      if (last) {
        const first = last === 'outbound' ? 'inbound' : 'outbound';
        backend.seed('messages', [
          message(orgId, conversationId, first, idle + 1),
          message(orgId, conversationId, last, idle),
        ]);
        if (opts.privateNoteAfter) {
          backend.seed('messages', {
            ...message(orgId, conversationId, 'outbound', idle - 1), sender_type: 'operator',
            content_type: 'note', is_private_note: true, content: 'nota interna do time',
          });
        }
      }
      return { contactId, conversationId };
    },
    addDeal(contactId, patch = {}) {
      const id = crypto.randomUUID();
      backend.seed('deals', {
        id, org_id: orgId, contact_id: contactId, title: 'Oportunidade de teste', status: 'open',
        lead_type: 'Lead', temperature: 'Frio', ...patch,
      });
      return id;
    },
    setBusinessHours(hours, timezone = 'America/Sao_Paulo') {
      backend.seed('app_settings', { org_id: orgId, id: 1, business_hours: hours });
      backend.seed('ai_agent_config', { id: crypto.randomUUID(), org_id: orgId, timezone });
    },
    done() {
      backend.restore();
    },
  };
}

function message(orgId: string, conversationId: string, direction: string, hoursOld: number): Row {
  return {
    id: crypto.randomUUID(), org_id: orgId, conversation_id: conversationId, direction,
    sender_type: direction === 'inbound' ? 'contact' : 'ai', content_type: 'text',
    content: direction === 'inbound' ? 'mensagem do lead' : 'mensagem do atendente',
    is_private_note: false, created_at: hoursAgo(hoursOld),
  };
}
