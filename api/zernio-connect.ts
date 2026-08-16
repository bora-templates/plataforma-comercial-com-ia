import { randomBytes } from 'node:crypto';
import { requireAdmin } from '../src/lib/admin-auth.js';
import { getCredential, setCredential } from '../src/lib/credentials.js';
import {
  ZernioError,
  getNumberInfo,
  listWhatsappAccounts,
  registerWebhook,
  resolveProfileId,
  type ZernioAccount,
  type ZernioNumberInfo,
} from '../src/lib/zernio.js';

// ============================================================================
// api/zernio-connect
// ----------------------------------------------------------------------------
// Roda DEPOIS que a Zernio API Key foi salva (api/credentials). Le a chave do
// cofre, resolve a conta WhatsApp conectada + profile + status do numero,
// gera/registra o webhook do Zernio e persiste os derivados (account_id,
// profile_id, webhook_secret, number_info cache). A chave nunca volta ao
// browser; toda chamada ao Zernio sai daqui.
//
//  POST  → resolve + registra webhook. Se houver mais de uma conta WhatsApp e
//          nenhuma escolhida, responde { needsSelection, accounts } para o
//          wizard exibir o seletor e reenviar com { accountId }.
//  GET   → status cacheado (numero + tier) para a tela de Configuracoes.
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

async function ensureWebhookSecret(orgId: string): Promise<string> {
  const existing = await getCredential(orgId, 'zernio_webhook_secret');
  if (existing && existing.trim()) return existing.trim();
  const secret = randomBytes(32).toString('hex');
  await setCredential(orgId, 'zernio_webhook_secret', secret);
  return secret;
}

function statusPayload(account: ZernioAccount | null, info: ZernioNumberInfo | null) {
  return {
    accountId: account?.id ?? null,
    accountName: account?.name ?? null,
    number: info
      ? {
          display_phone_number: info.display_phone_number,
          verified_name: info.verified_name,
          messaging_limit_tier: info.messaging_limit_tier,
          quality_rating: info.quality_rating,
          health_status: info.health_status,
        }
      : null,
  };
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
  return res.status(200).json({
    success: true,
    connected: Boolean(accountId),
    accountId,
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
  const apiKey = (await getCredential(orgId, 'zernio_api_key'))?.trim();
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      message: 'Salve a Zernio API Key antes de conectar.',
    });
  }

  const body = (req.body ?? {}) as { accountId?: unknown };
  const chosenId = typeof body.accountId === 'string' ? body.accountId.trim() : '';

  const accounts = await listWhatsappAccounts(apiKey);
  if (accounts.length === 0) {
    return res.status(400).json({
      success: false,
      message:
        'Nenhuma conta WhatsApp encontrada no Zernio. Conecte o WhatsApp no painel do Zernio antes de continuar.',
    });
  }

  let account: ZernioAccount | undefined;
  if (chosenId) {
    account = accounts.find((item) => item.id === chosenId);
    if (!account) {
      return res
        .status(400)
        .json({ success: false, message: 'Conta selecionada nao encontrada.' });
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    return res.status(200).json({
      success: false,
      needsSelection: true,
      accounts: accounts.map((item) => ({ id: item.id, name: item.name })),
    });
  }

  const profileId = await resolveProfileId(apiKey, account);
  const numberInfo = await getNumberInfo(apiKey, account.id);

  await setCredential(orgId, 'zernio_account_id', account.id);
  if (profileId) await setCredential(orgId, 'zernio_profile_id', profileId);
  await setCredential(orgId, 'zernio_number_info', JSON.stringify(numberInfo));

  // Webhook: gera/reusa o segredo e registra no Zernio. Best-effort — se o
  // registro falhar (ex.: endpoint a confirmar), o setup nao trava: o segredo
  // fica salvo e devolvemos um aviso para o operador registrar/retentar.
  const secret = await ensureWebhookSecret(orgId);
  let webhookWarning: string | null = null;
  try {
    await registerWebhook(apiKey, {
      url: webhookUrl(),
      secret,
    });
  } catch (err) {
    webhookWarning =
      err instanceof Error ? err.message : 'Falha ao registrar o webhook no Zernio.';
    console.error(JSON.stringify({ event: 'zernio_webhook_register_failed', message: webhookWarning }));
  }

  return res.status(200).json({
    success: true,
    ...statusPayload(account, numberInfo),
    profileId,
    webhookWarning,
  });
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
