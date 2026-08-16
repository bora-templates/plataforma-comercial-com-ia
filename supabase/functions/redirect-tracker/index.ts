// ============================================================================
// redirect-tracker · Fase 1
// ----------------------------------------------------------------------------
// Redirecionador invisível: GET /functions/v1/redirect-tracker/<slug>
// (exposto como https://<crm>/r/<slug> via rewrite). Captura o clique ANTES do
// destino final — é o que blinda WhatsApp/Instagram, onde não há código nosso.
//
// Requisito de produção: RESILIÊNCIA. O redirect responde rápido e sempre; a
// gravação da tracking_session é fire-and-forget (EdgeRuntime.waitUntil). Se o
// insert falhar ou o DB lentar, o usuário ainda é redirecionado.
//
// Deployado com --no-verify-jwt (função pública, sem auth — é um link clicável).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

// Fallback quando não há como resolver o destino (slug inválido / DB fora).
const FALLBACK_URL = Deno.env.get('REDIRECT_FALLBACK_URL') ?? 'https://google.com';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function genShortCode(len = 6): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

// Só http(s) — evita javascript:/data: como destino de redirect.
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // slug pode vir no path (/redirect-tracker/<slug>) ou em ?l= / ?linkId=
  const pathMatch = url.pathname.match(/\/redirect-tracker\/([^/?#]+)/);
  const slug = pathMatch?.[1] ?? url.searchParams.get('l') ?? url.searchParams.get('linkId');

  if (!slug) return redirect(FALLBACK_URL);

  // --- Lookup do link (crítico: precisamos do destino). Falha → fallback. ----
  let link: Record<string, unknown> | null = null;
  try {
    const supabase = getAdminClient();
    const { data } = await supabase
      .from('utm_links')
      .select('id, base_url, destination_type, wa_number, wa_message, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
      .eq('slug', slug)
      .maybeSingle();
    link = data as Record<string, unknown> | null;
  } catch (_err) {
    return redirect(FALLBACK_URL);
  }
  if (!link) return redirect(FALLBACK_URL);

  // --- Merge: query de entrada sobrepõe as UTMs base do link -----------------
  const incoming = Object.fromEntries(url.searchParams.entries());
  const utm: Record<string, string | null> = {};
  for (const k of UTM_KEYS) {
    utm[k] = (incoming[k] ?? (link[k] as string | null) ?? null) || null;
  }
  const fbclid = incoming.fbclid ?? null;
  const shortCode = genShortCode(6);
  const destType = (link.destination_type as string) ?? 'landing';

  // --- Monta o destino conforme o tipo ---------------------------------------
  let dest: string | null = null;
  if (destType === 'whatsapp') {
    const num = String(link.wa_number ?? '').replace(/\D/g, '');
    if (num) {
      const msg = `${(link.wa_message as string) ?? ''} [${shortCode}]`.trim();
      dest = `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
    }
  } else if (destType === 'landing') {
    const base = safeHttpUrl(link.base_url as string);
    if (base) {
      const d = new URL(base);
      for (const k of UTM_KEYS) if (utm[k]) d.searchParams.set(k, utm[k]!);
      if (fbclid) d.searchParams.set('fbclid', fbclid);
      d.searchParams.set('utm_ref', shortCode); // redundância: código também na URL
      dest = d.toString();
    }
  } else {
    // instagram | other → destino cru (tracking parcial: clique já registrado)
    dest = safeHttpUrl(link.base_url as string);
  }

  if (!dest) dest = FALLBACK_URL;

  // --- Grava a sessão de forma NÃO-bloqueante --------------------------------
  const sessionInsert = (async () => {
    try {
      const supabase = getAdminClient();
      await supabase.from('tracking_sessions').insert({
        short_code: shortCode,
        campaign_link_id: link!.id,
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        utm_content: utm.utm_content,
        utm_term: utm.utm_term,
        raw_query: incoming,
        fbclid,
        destination_type: destType,
        destination_url: dest,
        ip: req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip'),
        user_agent: req.headers.get('user-agent'),
        referer: req.headers.get('referer'),
      });
    } catch (err) {
      console.log(JSON.stringify({ event: 'tracking_session_insert_failed', slug, error: String(err) }));
    }
  })();

  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(sessionInsert);
  else {
    // Sem waitUntil: não travar o redirect por mais de 250ms pela gravação.
    await Promise.race([sessionInsert, new Promise((r) => setTimeout(r, 250))]);
  }

  return redirect(dest);
});
