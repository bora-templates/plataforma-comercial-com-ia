import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../src/lib/admin-auth.js';
import { removeChannel } from '../src/lib/channel-remove.js';

// ============================================================================
// api/channel-remove
// ----------------------------------------------------------------------------
// POST { channelId } → apaga um número DESATIVADO da organização do admin
// (whatsapp_hub.channels). Número ativo volta 409. A regra mora em
// src/lib/channel-remove.ts. Credenciais da Zernio não são tocadas.
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

function channelsTable() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } })
    .schema('whatsapp_hub')
    .from('channels');
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    const auth = await requireAdmin(authHeaderOf(req));
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    const body = (req.body ?? {}) as { channelId?: unknown };
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';

    const result = await removeChannel(
      {
        findChannel: async (orgId, id) => {
          const { data, error } = await channelsTable()
            .select('id, is_active')
            .eq('id', id)
            .eq('org_id', orgId)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return data ? { id: data.id as string, is_active: data.is_active === true } : null;
        },
        deleteChannel: async (orgId, id) => {
          const { error } = await channelsTable().delete().eq('id', id).eq('org_id', orgId);
          return error ? error.message : null;
        },
      },
      { orgId: auth.orgId, channelId },
    );
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('channel-remove error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
