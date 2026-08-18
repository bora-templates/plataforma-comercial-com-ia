import { ShieldCheck, Radio, Link2, Hand } from 'lucide-react';
import { getDealOrigin, TONE_PILL_CLASS, type DealOriginInput } from '@/lib/dealOrigin';

// Ícone de confiabilidade por método de atribuição.
const METHOD_ICON: Record<string, typeof ShieldCheck> = {
  'Click-to-WhatsApp': ShieldCheck,
  'Código de rastreio': Radio,
  'UTM da landing': Link2,
  Manual: Hand,
};

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-secondary)]">{label}</span>
      <span className="min-w-0 truncate text-right text-xs font-medium text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
}

// Bloco "Origem" completo — usado no drawer do lead e na ficha do contato.
export function OriginBlock({ deal }: { deal: DealOriginInput | null | undefined }) {
  const o = getDealOrigin(deal);
  const MethodIcon = METHOD_ICON[o.method] ?? Hand;

  if (!o.tracked) {
    return (
      <section className="space-y-2">
        <div className="text-label">Origem</div>
        <div className="rounded-lg border border-[rgba(212,165,116,0.12)] bg-white/[0.02] px-3 py-3 text-sm text-[var(--color-text-secondary)]">
          Origem não rastreada
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="text-label">Origem</div>
      <div className="space-y-3 rounded-lg border border-[rgba(212,165,116,0.15)] bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_PILL_CLASS[o.tone]}`}>
            {o.badge}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">{o.channel}</span>
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]" title={`Confiabilidade: ${o.methodReliability}`}>
            <MethodIcon className="h-3.5 w-3.5 text-[var(--accent-secondary)]" />
            {o.method}
          </span>
        </div>
        <div className="space-y-1.5 border-t border-[rgba(212,165,116,0.08)] pt-2">
          <Row label="Tráfego" value={o.trafficLabel} />
          <Row label="Campanha" value={o.utms.campaign} />
          <Row label="Conjunto" value={o.utms.term} />
          <Row label="Anúncio" value={o.utms.content} />
          <Row label="Source" value={o.utms.source} />
          <Row label="Medium" value={o.utms.medium} />
        </div>
      </div>
    </section>
  );
}
