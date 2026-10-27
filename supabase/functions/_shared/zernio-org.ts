// ============================================================================
// Organização dona de um evento da Zernio
// ----------------------------------------------------------------------------
// O webhook da Zernio é cadastrado sem ?org=. Com uma organização ativa, ela é
// a dona de tudo. Com mais de uma, a dona sai do evento, nesta ordem:
//   1. canal em whatsapp_hub.channels com o accountId do evento;
//   2. credencial zernio_account_id (o número de WhatsApp) igual ao accountId;
//   3. credencial zernio_instagram_account_ids (lista JSON) que contém o
//      accountId. A DM do Instagram chega com o id da conta de Instagram, que
//      não é o do número de WhatsApp. Se o evento traz profiles[] e a
//      organização tem zernio_profile_id, os dois precisam bater;
//   4. credencial zernio_profile_id igual a um dos profiles[].id do evento. O
//      perfil Zernio agrupa o WhatsApp e o Instagram do mesmo cliente.
// Duas organizações donas no mesmo passo: descarta e registra o motivo.
//
// Módulo puro: o acesso ao banco e ao cofre entra por ZernioOrgLookup, para o
// teste rodar no Node (tests/functions/zernio-org.test.mjs). O wizard cola este
// arquivo no mesmo escopo do index.ts, então nenhum nome de topo pode repetir
// um nome do zernio-webhook ou de outro _shared que ele importa.
// ============================================================================

export interface ZernioOrgRow {
  id: string;
  status: string;
}

export interface ZernioOrgLookup {
  findOrg(id: string): Promise<ZernioOrgRow | null>;
  activeOrgs(): Promise<ZernioOrgRow[]>;
  channelOrgByAccount(accountId: string): Promise<string | null>;
  credential(orgId: string, key: string): Promise<string | null>;
  log?(entry: Record<string, unknown>): void;
}

export interface ZernioOrgQuery {
  orgFromQuery: string | null;
  accountId: string | null;
  profileIds: string[];
}

function zoObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function zoString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function zoScopes(payload: unknown): Record<string, unknown>[] {
  const root = zoObject(payload);
  return root.data ? [root, zoObject(root.data)] : [root];
}

// Conta Zernio citada no evento. A DM do Instagram traz
// account: { accountId, platform }; outros eventos trazem account.id, o
// accountId dentro de message ou direto no corpo, que pode vir em data.
export function zernioEventAccountId(payload: unknown): string | null {
  for (const scope of zoScopes(payload)) {
    const fromAccount = zoString(zoObject(scope.account), ['accountId', 'id', '_id']);
    if (fromAccount) return fromAccount;
    const fromMessage = zoString(zoObject(scope.message), ['accountId', 'account_id']);
    if (fromMessage) return fromMessage;
    const direct = zoString(scope, ['accountId', 'account_id']);
    if (direct) return direct;
  }
  return null;
}

// Perfis Zernio do evento: profiles: [{ id, externalId }] no topo do corpo.
export function zernioEventProfileIds(payload: unknown): string[] {
  const ids: string[] = [];
  for (const scope of zoScopes(payload)) {
    if (!Array.isArray(scope.profiles)) continue;
    for (const item of scope.profiles) {
      const id = zoString(zoObject(item), ['id', '_id']);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// Lista de contas de Instagram gravada pelo api/zernio-connect. Valor
// ilegível conta como lista vazia.
export function parseZernioInstagramIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
      : [];
  } catch {
    return [];
  }
}

async function zoCredential(lookup: ZernioOrgLookup, orgId: string, key: string): Promise<string | null> {
  try {
    return await lookup.credential(orgId, key);
  } catch {
    // Credencial ilegível nesta organização: ela não é a dona.
    return null;
  }
}

// Organizações ativas cujo valor guardado em `key` casa com o evento.
async function zoOwners(
  lookup: ZernioOrgLookup,
  rows: ZernioOrgRow[],
  key: string,
  matches: (stored: string | null) => boolean,
): Promise<string[]> {
  const owners: string[] = [];
  for (const row of rows) {
    if (matches(await zoCredential(lookup, row.id, key))) owners.push(row.id);
  }
  return owners;
}

export async function resolveZernioOrg(
  lookup: ZernioOrgLookup,
  query: ZernioOrgQuery,
): Promise<{ orgId: string; status: string } | null> {
  if (query.orgFromQuery) {
    const org = await lookup.findOrg(query.orgFromQuery);
    return org ? { orgId: org.id, status: org.status } : null; // ?org= que não existe: descartar
  }
  const rows = await lookup.activeOrgs();
  if (rows.length === 1) return { orgId: rows[0].id, status: rows[0].status };
  const accountId = query.accountId?.trim() || null;
  const profileIds = query.profileIds.filter(Boolean);
  if (rows.length === 0 || (!accountId && profileIds.length === 0)) return null;

  const activeIds = new Set(rows.map((row) => row.id));
  const decide = (owners: string[], via: string): { orgId: string; status: string } | null | undefined => {
    if (owners.length === 1) return { orgId: owners[0], status: 'active' };
    if (owners.length > 1) {
      lookup.log?.({
        event: 'zernio_webhook_ambiguous_org',
        via,
        zernio_account_id: accountId,
        orgs: owners.length,
      });
      return null;
    }
    return undefined; // nenhuma dona neste passo: segue para o próximo
  };

  if (accountId) {
    try {
      const channelOrg = await lookup.channelOrgByAccount(accountId);
      if (channelOrg && activeIds.has(channelOrg)) return { orgId: channelOrg, status: 'active' };
    } catch {
      // Sem canal legível: segue para as credenciais.
    }

    const byWhatsapp = decide(
      await zoOwners(lookup, rows, 'zernio_account_id', (stored) => stored?.trim() === accountId),
      'zernio_account_id',
    );
    if (byWhatsapp !== undefined) return byWhatsapp;

    // Defesa: com profiles[] no evento e zernio_profile_id na organização, a
    // conta da lista só vale se o perfil bater. Uma lista gravada errada (a
    // mesma chave enxerga o Instagram de outro cliente) não rouba a DM.
    const listed = await zoOwners(lookup, rows, 'zernio_instagram_account_ids', (stored) =>
      parseZernioInstagramIds(stored).includes(accountId));
    const instagramOwners: string[] = [];
    for (const orgId of listed) {
      const orgProfile = (await zoCredential(lookup, orgId, 'zernio_profile_id'))?.trim();
      if (profileIds.length > 0 && orgProfile && !profileIds.includes(orgProfile)) {
        lookup.log?.({
          event: 'zernio_webhook_profile_mismatch',
          zernio_account_id: accountId,
          org_id: orgId,
        });
        continue;
      }
      instagramOwners.push(orgId);
    }
    const byInstagram = decide(instagramOwners, 'zernio_instagram_account_ids');
    if (byInstagram !== undefined) return byInstagram;
  }

  if (profileIds.length > 0) {
    const byProfile = decide(
      await zoOwners(lookup, rows, 'zernio_profile_id', (stored) =>
        Boolean(stored?.trim()) && profileIds.includes(stored!.trim())),
      'zernio_profile_id',
    );
    if (byProfile !== undefined) return byProfile;
  }
  return null;
}
