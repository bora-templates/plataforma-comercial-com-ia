import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../src/lib/admin-auth.js';
import { deleteCredential, getCredential, setCredential } from '../src/lib/credentials.js';
import { syncZernioChannel } from '../src/lib/zernio-channel.js';
import { instagramStatus, runZernioConnect } from '../src/lib/zernio-connect-flow.js';
import {
  ZernioError,
  getNumberInfo,
  listZernioAccounts,
  registerWebhook,
  resolveProfileId,
  type ZernioNumberInfo,
} from '../src/lib/zernio.js';

// ============================================================================
// api/zernio-connect
// ----------------------------------------------------------------------------
// Roda DEPOIS que a Zernio API Key foi salva (api/credentials). Le a chave do
// cofre, resolve a conta WhatsApp conectada + profile + status do numero e as
// contas de Instagram, gera/registra o webhook do Zernio e persiste os
// derivados (account_id, profile_id, webhook_secret, number_info cache,
// instagram_account_ids). A regra mora em src/lib/zernio-connect-flow.ts. A
// chave nunca volta ao browser; toda chamada ao Zernio sai daqui.
//
// O número conectado também vira canal da organização (whatsapp_hub.channels,
// provider='zernio'), que é o que a tela de Canais lista e o que a
// zernio-webhook usa para o operador vinculado e a IA por número.
//
//  POST  → resolve + registra webhook. Se houver mais de uma conta WhatsApp e
//          nenhuma escolhida, responde { needsSelection, accounts } para o
//          wizard exibir o seletor e reenviar com { accountId }.
//          Conta so com Instagram conecta o Instagram e cadastra o webhook.
//  GET   → status cacheado (numero + tier + Instagram) para a tela de Canais.
// ============================================================================

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function authHeaderOf(req: ApiRequest): string | string[] | undefined {
  return req.headers?.authorization ?? req.headers?.Authorization;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function webhookUrl(): string {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL ausente para montar a URL do webhook.');
  return `${base.replace(/\/$/, '')}/functions/v1/zernio-webhook`;
}

// Versão que não lança — usada no GET para exibir a URL na tela de
// Configurações mesmo quando SUPABASE_URL não está disponível no runtime.
function webhookUrlSafe(): string | null {
  const base = process.env.SUPABASE_URL;
  return base ? `${base.replace(/\/$/, '')}/functions/v1/zernio-webhook` : null;
}

async function handleGet(orgId: string, res: ApiResponse) {
  const accountId = (await getCredential(orgId, 'zernio_account_id'))?.trim() || null;
  const rawInfo = await getCredential(orgId, 'zernio_number_info');
  let info: ZernioNumberInfo | null = null;
  if (rawInfo) {
    try {
      info = JSON.parse(rawInfo) as ZernioNumberInfo;
    } catch {
      info = null;
    }
  }
  const instagram = instagramStatus(
    await getCredential(orgId, 'zernio_instagram_account_ids'),
    await getCredential(orgId, 'zernio_instagram_accounts'),
  );
  return res.status(200).json({
    success: true,
    connected: Boolean(accountId),
    accountId,
    instagram,
    webhook_url: webhookUrlSafe(),
    number: info
      ? {
          display_phone_number: info.display_phone_number,
          verified_name: info.verified_name,
          messaging_limit_tier: info.messaging_limit_tier,
          quality_rating: info.quality_rating,
          health_status: info.health_status,
        }
      : null,
  });
}

async function handlePost(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { accountId?: unknown };
  const chosenId = typeof body.accountId === 'string' ? body.accountId.trim() : '';

  const result = await runZernioConnect(
    {
      getCredential: (key) => getCredential(orgId, key),
      setCredential: (key, value) => setCredential(orgId, key, value),
      deleteCredential: (key) => deleteCredential(orgId, key),
      listAccounts: listZernioAccounts,
      resolveProfileId,
      getNumberInfo,
      registerWebhook,
      syncChannel: (account, numberInfo) =>
        syncZernioChannel(getSupabaseAdmin(), { orgId, account, numberInfo }),
      webhookUrl,
      newSecret: () => randomBytes(32).toString('hex'),
    },
    { chosenId },
  );
  return res.status(result.status).json(result.body);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

    const auth = await requireAdmin(authHeaderOf(req));
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    // `await` é essencial: sem ele, uma rejeição de handlePost/handleGet escapa
    // do try/catch como unhandled rejection → a Vercel devolve
    // FUNCTION_INVOCATION_FAILED em vez do JSON de erro tratado.
    return await (req.method === 'GET' ? handleGet(auth.orgId, res) : handlePost(auth.orgId, req, res));
  } catch (err) {
    if (err instanceof ZernioError) {
      return res.status(err.status === 401 ? 401 : 502).json({
        success: false,
        message: err.message,
      });
    }
    console.error('zernio-connect error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
