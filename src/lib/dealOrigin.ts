// ============================================================================
// getDealOrigin — normaliza a atribuição de um lead para exibição consistente
// no card, no drawer e na ficha do contato (Fase 6). Fonte única de verdade da
// UI de origem: os três lugares consomem este helper.
// ============================================================================

export interface DealOriginInput {
  attribution_method?: string | null;
  origin_channel?: string | null;
  traffic_type?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export type TrafficTone = 'pago' | 'organico' | 'manual' | 'outro';

export interface DealOriginView {
  tracked: boolean;
  badge: string;        // destaque de alto nível (Meta Ads / Google Ads / Orgânico / …)
  tone: TrafficTone;    // cor por tipo de tráfego
  channel: string;      // canal granular legível (Instagram Ads / Facebook Ads / …)
  trafficLabel: string; // Pago / Orgânico / Manual
  method: string;       // Click-to-WhatsApp / Código de rastreio / UTM da landing / Manual
  methodReliability: 'alta' | 'media' | 'baixa';
  utms: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
}

// Canal granular → rótulo legível.
const CHANNEL_LABEL: Record<string, string> = {
  instagram_ads: 'Instagram Ads',
  facebook_ads: 'Facebook Ads',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  google_organico: 'Google (orgânico)',
  instagram_organico: 'Instagram (orgânico)',
  facebook_organico: 'Facebook (orgânico)',
  tiktok_ads: 'TikTok Ads',
  tiktok_organico: 'TikTok (orgânico)',
  linkedin_ads: 'LinkedIn Ads',
  linkedin_organico: 'LinkedIn (orgânico)',
  youtube_ads: 'YouTube Ads',
  whatsapp_direto: 'WhatsApp direto',
  outro: 'Outro',
};

// Canal → badge de destaque (agrupa fb/ig/meta em "Meta Ads" na exibição alta).
const CHANNEL_BADGE: Record<string, string> = {
  instagram_ads: 'Meta Ads',
  facebook_ads: 'Meta Ads',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
  linkedin_ads: 'LinkedIn Ads',
  youtube_ads: 'YouTube Ads',
  google_organico: 'Orgânico',
  instagram_organico: 'Orgânico',
  facebook_organico: 'Orgânico',
  tiktok_organico: 'Orgânico',
  linkedin_organico: 'Orgânico',
  whatsapp_direto: 'WhatsApp direto',
  outro: 'Outro',
};

const METHOD_LABEL: Record<string, { label: string; reliability: DealOriginView['methodReliability'] }> = {
  ctwa: { label: 'Click-to-WhatsApp', reliability: 'alta' },
  codigo_rastreio: { label: 'Código de rastreio', reliability: 'alta' },
  utm_landing: { label: 'UTM da landing', reliability: 'media' },
  manual: { label: 'Manual', reliability: 'baixa' },
};

const TRAFFIC_LABEL: Record<string, string> = { pago: 'Pago', organico: 'Orgânico', manual: 'Manual' };

export function getDealOrigin(lead: DealOriginInput | null | undefined): DealOriginView {
  const l = lead ?? {};
  const utms = {
    source: l.utm_source ?? null,
    medium: l.utm_medium ?? null,
    campaign: l.utm_campaign ?? null,
    content: l.utm_content ?? null,
    term: l.utm_term ?? null,
  };
  const hasUtm = Object.values(utms).some((v) => v != null && v !== '');
  const channelKey = l.origin_channel ?? null;
  const tracked = Boolean(l.attribution_method || channelKey || hasUtm);

  const traffic = (l.traffic_type ?? '') as string;
  const tone: TrafficTone =
    traffic === 'pago' ? 'pago' : traffic === 'organico' ? 'organico' : traffic === 'manual' ? 'manual' : 'outro';

  const method = METHOD_LABEL[l.attribution_method ?? ''] ?? { label: 'Manual', reliability: 'baixa' as const };

  if (!tracked) {
    return {
      tracked: false,
      badge: 'Origem não rastreada',
      tone: 'outro',
      channel: '—',
      trafficLabel: '—',
      method: method.label,
      methodReliability: method.reliability,
      utms,
    };
  }

  const badge = channelKey ? (CHANNEL_BADGE[channelKey] ?? 'Outro') : traffic === 'manual' ? 'Manual' : 'Outro';
  const channel = channelKey ? (CHANNEL_LABEL[channelKey] ?? channelKey) : 'Outro';

  return {
    tracked: true,
    badge,
    tone,
    channel,
    trafficLabel: TRAFFIC_LABEL[traffic] ?? '—',
    method: method.label,
    methodReliability: method.reliability,
    utms,
  };
}

// Classes utilitárias por tom (cor coerente com o design system).
export const TONE_PILL_CLASS: Record<TrafficTone, string> = {
  pago: 'border-[rgba(var(--accent-rgb),0.35)] bg-[rgba(var(--accent-rgb),0.12)] text-[var(--accent-secondary)]',
  organico: 'border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.12)] text-[#34D399]',
  manual: 'border-[rgba(148,163,184,0.35)] bg-[rgba(148,163,184,0.12)] text-[#CBD5E1]',
  outro: 'border-[rgba(148,163,184,0.25)] bg-[rgba(148,163,184,0.08)] text-[var(--color-text-secondary)]',
};
