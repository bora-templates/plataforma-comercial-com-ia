// ============================================================================
// ingest-lead  (público, CORS aberto)  · Fase 5
// ----------------------------------------------------------------------------
// Caminho landing → CRM. O snippet (public/ah-tracker.js) captura UTMs +
// fbclid + short_code (utm_ref) e, no submit do form, POSTa aqui os dados do
// lead + contexto de tracking. Cria o lead com snapshot de UTMs e
// attribution_method = utm_landing, casando a tracking_session quando há code.
//
// Deploy com --no-verify-jwt (chamado do browser da landing do cliente).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

interface LeadBody {
  name?: string;
  phone?: string;
  email?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  short_code?: string;      // = utm_ref injetado pelo redirecionador
  raw_query?: Record<string, unknown>;
  page_url?: string;
}

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function normalizePhone(raw: string): string {
  const t = raw.trim();
  return t.startsWith('+') ? t : `+${t.replace(/[^\d]/g, '')}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, { status: 405 });
  }

  let body: LeadBody;
  try { body = (await req.json()) as LeadBody; }
  catch { return jsonResponse({ ok: false, error: 'JSON inválido' }, { status: 400 }); }

  const phone = clean(body.phone) ? normalizePhone(body.phone!) : null;
  const email = clean(body.email);
  const name = clean(body.name);
  if (!phone && !email) {
    return jsonResponse({ ok: false, error: 'Informe telefone ou email.' }, { status: 400 });
  }

  const admin = getAdminClient();

  // Resolve/cria contato por telefone (preferido) ou email.
  let contactId: string | null = null;
  const lookup = phone
    ? admin.from('contacts').select('id').eq('phone', phone).maybeSingle()
    : admin.from('contacts').select('id').eq('email', email!).maybeSingle();
  const { data: existing } = await lookup;
  if (existing) contactId = (existing as { id: string }).id;
  else {
    const insert: Record<string, unknown> = { name, source: 'landing' };
    if (phone) insert.phone = phone;
    if (email) insert.email = email;
    const { data: created, error } = await admin
      .from('contacts').insert(insert).select('id').single();
    if (error) {
      return jsonResponse({ ok: false, error: `contato: ${error.message}` }, { status: 500 });
    }
    contactId = (created as { id: string }).id;
  }

  const utm = {
    utm_source: clean(body.utm_source),
    utm_medium: clean(body.utm_medium),
    utm_campaign: clean(body.utm_campaign),
    utm_content: clean(body.utm_content),
    utm_term: clean(body.utm_term),
  };
  const raw = {
    ...(body.raw_query && typeof body.raw_query === 'object' ? body.raw_query : {}),
    fbclid: clean(body.fbclid),
    page_url: clean(body.page_url),
  };

  const { data: result, error: rpcErr } = await admin.rpc('ingest_landing_lead', {
    p_contact_id: contactId,
    p_utm: utm,
    p_raw: raw,
    p_short_code: clean(body.short_code),
  });
  if (rpcErr) {
    return jsonResponse({ ok: false, error: `ingestão: ${rpcErr.message}` }, { status: 500 });
  }

  console.log(JSON.stringify({ event: 'landing_lead_ingested', result }));
  return jsonResponse({ ok: true, attribution: result });
});
