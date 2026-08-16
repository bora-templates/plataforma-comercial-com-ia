import { getDealOrigin, TONE_PILL_CLASS, type DealOriginInput } from '@/lib/dealOrigin';

// Pill compacta de origem para o card do lead. Não renderiza nada quando o lead
// não tem origem rastreada (evita poluir o card).
export function OriginBadge({ deal }: { deal: DealOriginInput }) {
  const o = getDealOrigin(deal);
  if (!o.tracked) return null;
  return (
    <span
      className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TONE_PILL_CLASS[o.tone]}`}
      title={`${o.channel} · ${o.method}`}
    >
      {o.badge}
    </span>
  );
}
