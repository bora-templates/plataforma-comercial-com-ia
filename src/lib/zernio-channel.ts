import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZernioAccount, ZernioNumberInfo } from './zernio.js';

// ============================================================================
// Número oficial da Zernio como canal da organização
// ----------------------------------------------------------------------------
// A tela Configurações > Canais, a atribuição por número e a IA por número
// leem whatsapp_hub.channels. A conexão da Zernio guardava a conta só nas
// credenciais, então o número oficial nunca virava canal. Aqui ele vira: uma
// linha por (org_id, provider, zernio_account_id), a mesma regra do banco
// (channels_zernio_account_unique). Reconectar atualiza o telefone e não mexe
// no que a equipe ajustou no canal (nome, ativo, IA e operador vinculado).
// ============================================================================

const FALLBACK_LABEL = 'WhatsApp oficial';

export interface ZernioChannelInput {
  orgId: string;
  account: Pick<ZernioAccount, 'id' | 'name'>;
  numberInfo: Pick<ZernioNumberInfo, 'display_phone_number' | 'verified_name'> | null;
}

interface ExistingChannel {
  id: string;
  label: string | null;
  phone: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

export async function syncZernioChannel(
  db: SupabaseClient,
  input: ZernioChannelInput,
): Promise<{ channelId: string; created: boolean }> {
  const channels = () => db.schema('whatsapp_hub').from('channels');
  const phone = clean(input.numberInfo?.display_phone_number);
  const label = clean(input.numberInfo?.verified_name) ?? clean(input.account.name) ?? FALLBACK_LABEL;

  const findExisting = async (): Promise<ExistingChannel | null> => {
    const { data, error } = await channels()
      .select('id, label, phone')
      .eq('org_id', input.orgId)
      .eq('provider', 'zernio')
      .eq('zernio_account_id', input.account.id)
      .maybeSingle();
    if (error) throw new Error(`Falha ao ler o canal da Zernio: ${error.message}`);
    return (data as ExistingChannel | null) ?? null;
  };

  const existing = await findExisting();
  if (existing) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (phone && phone !== existing.phone) patch.phone = phone;
    if (!clean(existing.label)) patch.label = label;
    const { error } = await channels().update(patch).eq('id', existing.id);
    if (error) throw new Error(`Falha ao atualizar o canal da Zernio: ${error.message}`);
    return { channelId: existing.id, created: false };
  }

  const { data: created, error } = await channels()
    .insert({
      org_id: input.orgId,
      provider: 'zernio',
      zernio_account_id: input.account.id,
      label,
      phone,
    })
    .select('id')
    .single();
  if (error) {
    // Outro pedido gravou o mesmo canal entre a leitura e a gravação.
    if (error.code === '23505') {
      const winner = await findExisting();
      if (winner) return { channelId: winner.id, created: false };
    }
    throw new Error(`Falha ao gravar o canal da Zernio: ${error.message}`);
  }
  return { channelId: (created as { id: string }).id, created: true };
}
