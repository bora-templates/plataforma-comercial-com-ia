import type { ZernioAccount, ZernioNumberInfo, ZernioProfileRef } from './zernio.js';

// ============================================================================
// Conexão da Zernio: WhatsApp e Instagram
// ----------------------------------------------------------------------------
// Roda no POST do api/zernio-connect (salvar a chave e "Sincronizar números").
// Lista TODAS as contas da Zernio:
//   · WhatsApp: o número escolhido vira zernio_account_id e canal, como antes.
//   · Instagram: os ids das contas DO MESMO PERFIL Zernio do número vão para
//     zernio_instagram_account_ids (lista JSON) e os nomes de usuário para
//     zernio_instagram_accounts, no mesmo cofre cifrado por organização. O
//     zernio-webhook usa a lista para achar a organização da DM quando há
//     mais de uma ativa.
// Conta só com Instagram não falha: guarda o Instagram do perfil escolhido,
// cadastra o webhook e avisa que nenhum número de WhatsApp foi achado. Com
// mais de um perfil, pede a escolha antes de gravar.
//
// As dependências entram por parâmetro para o fluxo rodar no teste
// (tests/api/zernio-connect.test.mjs) com o cofre em memória e fetch falso.
// Este arquivo só importa tipos, e por isso o Node carrega o TypeScript direto.
// ============================================================================

export interface ZernioConnectDeps {
  getCredential(key: string): Promise<string | null>;
  setCredential(key: string, value: string): Promise<void>;
  deleteCredential(key: string): Promise<void>;
  listAccounts(apiKey: string): Promise<ZernioAccount[]>;
  resolveProfileId(apiKey: string, account: ZernioAccount): Promise<ZernioProfileRef | null>;
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

// Grava as contas de Instagram da organização. Só entram as do perfil Zernio
// escolhido: a mesma API Key enxerga os perfis de todos os clientes (modelo
// multi-tenant da Zernio), e guardar o Instagram de outro perfil faria esta
// organização receber as DMs do outro cliente. Conta sem perfil informado
// não é atribuída. Lista vazia também é gravada, para a conta desconectada no
// painel deixar de valer.
async function saveInstagram(
  deps: ZernioConnectDeps,
  instagramAccounts: ZernioAccount[],
  profileId: string | null,
): Promise<InstagramStatus> {
  const own = profileId ? instagramAccounts.filter((account) => account.profileId === profileId) : [];
  const view: InstagramAccountView[] = own.map((account) => ({
    id: account.id,
    username: account.username ?? null,
  }));
  await deps.setCredential('zernio_instagram_account_ids', JSON.stringify(view.map((account) => account.id)));
  await deps.setCredential('zernio_instagram_accounts', JSON.stringify(view));
  return { connected: view.length > 0, accounts: view };
}

// Grava o perfil Zernio da organização em duas chaves independentes:
//   · zernio_profile_id: o perfil para os disparos, inclusive o do último
//     recurso (primeiro da lista), porque os broadcasts dependem dele;
//   · zernio_profile_confirmed_id: o mesmo id, só quando confirmado. É a única
//     chave que o zernio-webhook lê para rotear por perfil. Sem confirmação,
//     ela é apagada.
// Uma chave só para o webhook evita ler, entre duas gravações ou no cache de
// credenciais da Edge, um perfil novo com uma marca de confirmado antiga. Sem
// perfil nenhum, as duas saem, para a defesa do webhook não descartar DM
// legítima com um perfil velho.
async function saveProfile(deps: ZernioConnectDeps, profile: ZernioProfileRef | null): Promise<void> {
  if (profile?.confirmed) {
    await deps.setCredential('zernio_profile_confirmed_id', profile.id);
  } else {
    await deps.deleteCredential('zernio_profile_confirmed_id');
  }
  if (profile) {
    await deps.setCredential('zernio_profile_id', profile.id);
  } else {
    await deps.deleteCredential('zernio_profile_id');
  }
}

function instagramLabel(account: ZernioAccount): string {
  return account.username ? `@${account.username.replace(/^@/, '')}` : account.name;
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

  // Conta só com Instagram: o perfil sai da conta de Instagram. Com mais de um
  // perfil na chave, a tela pede a escolha (nada é gravado antes dela). O
  // número guardado antes (se houver) fica como está.
  if (whatsapp.length === 0) {
    const groupOf = (account: ZernioAccount) => account.profileId ?? `conta:${account.id}`;
    const groups = new Set(instagramAccounts.map(groupOf));
    let chosen: ZernioAccount | undefined;
    if (input.chosenId) {
      chosen = instagramAccounts.find((item) => item.id === input.chosenId);
      if (!chosen) {
        return { status: 400, body: { success: false, message: 'Conta selecionada não encontrada.' } };
      }
    } else if (groups.size === 1) {
      chosen = instagramAccounts[0];
    } else {
      return {
        status: 200,
        body: {
          success: false,
          needsSelection: true,
          kind: 'instagram',
          accounts: instagramAccounts.map((item) => ({ id: item.id, name: instagramLabel(item) })),
        },
      };
    }

    const profileId = chosen.profileId;
    let instagram: InstagramStatus;
    if (profileId) {
      await saveProfile(deps, { id: profileId, confirmed: true });
      instagram = await saveInstagram(deps, instagramAccounts, profileId);
    } else {
      // Sem perfil informado: só a conta escolhida, e o perfil antigo sai.
      await saveProfile(deps, null);
      const view = [{ id: chosen.id, username: chosen.username ?? null }];
      await deps.setCredential('zernio_instagram_account_ids', JSON.stringify([chosen.id]));
      await deps.setCredential('zernio_instagram_accounts', JSON.stringify(view));
      instagram = { connected: true, accounts: view };
    }
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
        profileId: profileId ?? null,
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
      return { status: 400, body: { success: false, message: 'Conta selecionada não encontrada.' } };
    }
  } else if (whatsapp.length === 1) {
    account = whatsapp[0];
  } else {
    return {
      status: 200,
      body: {
        success: false,
        needsSelection: true,
        kind: 'whatsapp',
        accounts: whatsapp.map((item) => ({ id: item.id, name: item.name })),
      },
    };
  }

  const profile = await deps.resolveProfileId(apiKey, account);
  const profileId = profile?.id ?? null;
  const numberInfo = await deps.getNumberInfo(apiKey, account.id);

  await deps.setCredential('zernio_account_id', account.id);
  await saveProfile(deps, profile);
  await deps.setCredential('zernio_number_info', JSON.stringify(numberInfo));
  // Instagram só com perfil confirmado: o primeiro perfil da lista pode ser de
  // outro cliente da mesma chave.
  const instagram = await saveInstagram(deps, instagramAccounts, profile?.confirmed ? profile.id : null);

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
