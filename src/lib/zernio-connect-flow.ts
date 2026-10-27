import type { ZernioAccount, ZernioNumberInfo } from './zernio.js';

// ============================================================================
// Conexão da Zernio: WhatsApp e Instagram
// ----------------------------------------------------------------------------
// Roda no POST do api/zernio-connect (salvar a chave e "Sincronizar números").
// Lista TODAS as contas da Zernio:
//   · WhatsApp: o número escolhido vira zernio_account_id e canal, como antes.
//   · Instagram: os ids das contas vão para zernio_instagram_account_ids (lista
//     JSON) e os nomes de usuário para zernio_instagram_accounts, no mesmo
//     cofre cifrado por organização. O zernio-webhook usa a lista para achar a
//     organização da DM quando há mais de uma ativa.
// Conta só com Instagram não falha: guarda o Instagram, cadastra o webhook e
// avisa que nenhum número de WhatsApp foi achado.
//
// As dependências entram por parâmetro para o fluxo rodar no teste
// (tests/api/zernio-connect.test.mjs) com o cofre em memória e fetch falso.
// Este arquivo só importa tipos, e por isso o Node carrega o TypeScript direto.
// ============================================================================

export interface ZernioConnectDeps {
  getCredential(key: string): Promise<string | null>;
  setCredential(key: string, value: string): Promise<void>;
  listAccounts(apiKey: string): Promise<ZernioAccount[]>;
  resolveProfileId(apiKey: string, account: ZernioAccount): Promise<string | null>;
  getNumberInfo(apiKey: string, accountId: string): Promise<ZernioNumberInfo>;
  registerWebhook(apiKey: string, opts: { url: string; secret: string }): Promise<void>;
  syncChannel(account: ZernioAccount, numberInfo: ZernioNumberInfo): Promise<{ channelId: string | null }>;
  webhookUrl(): string;
  newSecret(): string;
}

export interface InstagramAccountView {
  id: string;
  username: string | null;
}

export interface InstagramStatus {
  connected: boolean;
  accounts: InstagramAccountView[];
}

export interface ZernioConnectResult {
  status: number;
  body: Record<string, unknown>;
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Estado do Instagram para a tela, a partir das duas credenciais. A lista de
// ids decide se está conectado; os nomes são só para exibir.
export function instagramStatus(rawIds: string | null, rawAccounts: string | null): InstagramStatus {
  const ids = parseJsonArray(rawIds).filter(
    (id): id is string => typeof id === 'string' && id.trim() !== '',
  );
  const names = new Map<string, string | null>();
  for (const item of parseJsonArray(rawAccounts)) {
    if (item && typeof item === 'object') {
      const { id, username } = item as { id?: unknown; username?: unknown };
      if (typeof id === 'string') names.set(id, typeof username === 'string' && username.trim() ? username : null);
    }
  }
  return {
    connected: ids.length > 0,
    accounts: ids.map((id) => ({ id, username: names.get(id) ?? null })),
  };
}

async function ensureWebhookSecret(deps: ZernioConnectDeps): Promise<string> {
  const existing = (await deps.getCredential('zernio_webhook_secret'))?.trim();
  if (existing) return existing;
  const secret = deps.newSecret();
  await deps.setCredential('zernio_webhook_secret', secret);
  return secret;
}

// Cadastra o webhook. Best-effort: se falhar, o segredo fica salvo e a tela
// recebe o aviso para tentar de novo.
async function registerWebhookSafe(deps: ZernioConnectDeps, apiKey: string): Promise<string | null> {
  const secret = await ensureWebhookSecret(deps);
  try {
    await deps.registerWebhook(apiKey, { url: deps.webhookUrl(), secret });
    return null;
  } catch (err) {
    const warning = err instanceof Error ? err.message : 'Falha ao registrar o webhook no Zernio.';
    console.error(JSON.stringify({ event: 'zernio_webhook_register_failed', message: warning }));
    return warning;
  }
}

function numberPayload(info: ZernioNumberInfo | null) {
  return info
    ? {
        display_phone_number: info.display_phone_number,
        verified_name: info.verified_name,
        messaging_limit_tier: info.messaging_limit_tier,
        quality_rating: info.quality_rating,
        health_status: info.health_status,
      }
    : null;
}

export async function runZernioConnect(
  deps: ZernioConnectDeps,
  input: { chosenId: string },
): Promise<ZernioConnectResult> {
  const apiKey = (await deps.getCredential('zernio_api_key'))?.trim();
  if (!apiKey) {
    return {
      status: 400,
      body: { success: false, message: 'Salve a Zernio API Key antes de conectar.' },
    };
  }

  const all = await deps.listAccounts(apiKey);
  const whatsapp = all.filter((account) => account.platform === 'whatsapp');
  const instagramAccounts = all.filter((account) => account.platform === 'instagram');

  if (whatsapp.length === 0 && instagramAccounts.length === 0) {
    return {
      status: 400,
      body: {
        success: false,
        message:
          'Nenhuma conta WhatsApp ou Instagram encontrada no Zernio. Conecte o WhatsApp ou o Instagram no painel do Zernio antes de continuar.',
      },
    };
  }

  // Instagram primeiro: a lista vale mesmo se a tela ainda for pedir a escolha
  // do número. Lista vazia também é gravada, para a conta desconectada no
  // painel deixar de valer.
  const instagramView: InstagramAccountView[] = instagramAccounts.map((account) => ({
    id: account.id,
    username: account.username ?? null,
  }));
  await deps.setCredential(
    'zernio_instagram_account_ids',
    JSON.stringify(instagramView.map((account) => account.id)),
  );
  await deps.setCredential('zernio_instagram_accounts', JSON.stringify(instagramView));
  const instagram: InstagramStatus = { connected: instagramView.length > 0, accounts: instagramView };

  // Conta só com Instagram: perfil, webhook e aviso. O número guardado antes
  // (se houver) fica como está.
  if (whatsapp.length === 0) {
    const profileId = await deps.resolveProfileId(apiKey, instagramAccounts[0]);
    if (profileId) await deps.setCredential('zernio_profile_id', profileId);
    const webhookWarning = await registerWebhookSafe(deps, apiKey);
    return {
      status: 200,
      body: {
        success: true,
        message:
          'Nenhum número de WhatsApp foi encontrado na Zernio. O Instagram foi conectado.',
        accountId: null,
        accountName: null,
        number: null,
        profileId,
        channelId: null,
        instagram,
        webhookWarning,
      },
    };
  }

  let account: ZernioAccount | undefined;
  if (input.chosenId) {
    account = whatsapp.find((item) => item.id === input.chosenId);
    if (!account) {
      return { status: 400, body: { success: false, message: 'Conta selecionada nao encontrada.' } };
    }
  } else if (whatsapp.length === 1) {
    account = whatsapp[0];
  } else {
    return {
      status: 200,
      body: {
        success: false,
        needsSelection: true,
        accounts: whatsapp.map((item) => ({ id: item.id, name: item.name })),
        instagram,
      },
    };
  }

  const profileId = await deps.resolveProfileId(apiKey, account);
  const numberInfo = await deps.getNumberInfo(apiKey, account.id);

  await deps.setCredential('zernio_account_id', account.id);
  if (profileId) await deps.setCredential('zernio_profile_id', profileId);
  await deps.setCredential('zernio_number_info', JSON.stringify(numberInfo));

  const webhookWarning = await registerWebhookSafe(deps, apiKey);

  // Depois do webhook: se a gravação do canal falhar, as mensagens já chegam e
  // reconectar refaz só o que faltou.
  const channel = await deps.syncChannel(account, numberInfo);

  return {
    status: 200,
    body: {
      success: true,
      accountId: account.id,
      accountName: account.name,
      number: numberPayload(numberInfo),
      profileId,
      channelId: channel.channelId,
      instagram,
      webhookWarning,
    },
  };
}
