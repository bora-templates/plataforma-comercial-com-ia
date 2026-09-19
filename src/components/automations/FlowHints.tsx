// ============================================================================
// Avisos das telas de Fluxos (Follow-ups e ações de etapa). Cada aviso descreve
// uma trava do motor (supabase/functions/_shared/follow-up-rules.ts), então o
// texto daqui muda junto quando o comportamento do motor mudar.
// Nomes de seção vêm de VOCAB, para o mesmo arquivo servir a cada instalação.
// ============================================================================

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { hasBusinessHours, unfilledFlowVariables, usesNameVariable } from '@/lib/flow-messages';
import { VOCAB } from '@/config/vocab';

const hintCls = 'text-xs leading-relaxed text-[var(--color-text-secondary)]';
const warnCls =
  'flex items-start gap-2 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-2 text-sm text-[#FBBF24]';
const inputCls =
  'w-full rounded-lg border border-[rgba(212,165,116,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

const HOURS_PLACE = `${VOCAB.aiAgent} → Horário de atendimento`;

// Frase fixa do topo da aba Follow-ups.
export const FOLLOW_UP_INTRO =
  `As regras são verificadas a cada 15 minutos e disparam dentro do horário salvo em ${HOURS_PLACE}. `
  + 'Fora do horário, a mensagem espera a próxima abertura. Cada regra dispara no máximo uma vez por pessoa.';

// null enquanto carrega ou quando a leitura falha, para nunca avisar por engano.
function useBusinessHoursSaved(): boolean | null {
  const { orgId } = useAppUser();
  const [saved, setSaved] = useState<boolean | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void getSupabase()
      .from('app_settings')
      .select('business_hours')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error) return;
        setSaved(hasBusinessHours((data as { business_hours?: unknown } | null)?.business_hours));
      });
    return () => { cancelled = true; };
  }, [orgId]);

  return saved;
}

// Conta sem horário salvo: o motor continua enviando a qualquer hora.
export function BusinessHoursNotice() {
  const saved = useBusinessHoursSaved();
  if (saved !== false) return null;
  return (
    <div className={warnCls}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Esta conta ainda está sem horário de atendimento salvo, então o follow-up pode sair a qualquer hora,
        inclusive de madrugada. Salve o horário em {HOURS_PLACE}.
      </span>
    </div>
  );
}

export function InactivityHint() {
  return (
    <p className={hintCls}>
      A regra vale para conversas de WhatsApp que receberam mensagem depois que ela foi ligada, até 7 dias além
      do tempo escolhido. Ela dispara quando a última mensagem da conversa é da sua empresa, e deixa de fora quem
      está esperando resposta e a conversa que está com uma pessoa do time.
    </p>
  );
}

// Por padrão a regra de inatividade pula a conversa que está com o time
// (human_active ou IA pausada). Conta que atende só com pessoas tem TODAS as
// conversas nesse estado, porque o process-ai-message entrega cada conversa ao
// time quando o atendente de IA está desligado. Sem esta opção, ela nunca
// receberia follow-up. Grava params.include_human_active.
export function IncludeHumanToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-text-secondary)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
      />
      <span>
        Incluir conversas que estão com uma pessoa do time. Marque quando o atendimento da sua conta é feito só
        por pessoas, sem o {VOCAB.aiAgent}. Quem está esperando resposta continua de fora.
      </span>
    </label>
  );
}

export function FreeTextNameHint() {
  return (
    <p className={`mt-1 ${hintCls}`}>
      Escreva {'{nome}'} onde quiser o primeiro nome da pessoa. Quem estiver sem nome recebe a frase sem essa parte.
    </p>
  );
}

export function TagFilterHint() {
  return (
    <p className={`mt-1 ${hintCls}`}>
      O filtro de tag encontra a tag colocada na pessoa e também a tag colocada pela ação Adicionar tag, em{' '}
      {VOCAB.automations} → {VOCAB.funnel}.
    </p>
  );
}

export function AddTagHint() {
  return (
    <p className={`sm:col-span-2 ${hintCls}`}>
      O filtro de tag das regras de follow-up enxerga a tag colocada por esta ação.
    </p>
  );
}

// Template escolhido num fluxo. O fluxo preenche só a {{1}}, com o primeiro nome.
// Com {{2}} em diante o motor recusa o envio, então a tela avisa e bloqueia.
export function TemplateVariablesHint({
  body, fallback, onFallbackChange, className,
}: {
  body: string | null | undefined;
  fallback: string;
  onFallbackChange: (value: string) => void;
  className?: string;
}) {
  const unfilled = unfilledFlowVariables(body);

  if (unfilled.length > 0) {
    const names = unfilled.map((n) => `{{${n}}}`);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
    const empty = names.length === 1 ? `A variável ${list} sairia vazia` : `As variáveis ${list} sairiam vazias`;
    return (
      <div className={`${warnCls} ${className ?? ''}`}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Este template tem mais variáveis do que o fluxo sabe preencher. O fluxo preenche só a {'{{1}}'}, com o
          primeiro nome da pessoa. {empty}, e a Meta recusaria o envio. Escolha um template com no máximo uma
          variável, ou use este em {VOCAB.campaigns}, onde você define o valor de cada variável.
        </span>
      </div>
    );
  }

  if (!usesNameVariable(body)) return null;

  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <p className={hintCls}>
        A variável {'{{1}}'} sai com o primeiro nome da pessoa, como está em {VOCAB.contacts}.
      </p>
      <input
        value={fallback}
        onChange={(e) => onFallbackChange(e.target.value)}
        placeholder="Se a pessoa estiver sem nome, usar (opcional)"
        className={inputCls}
      />
      <p className={hintCls}>
        Sem nome e sem esse texto, a pessoa fica de fora deste envio, porque a variável nunca sai vazia.
      </p>
    </div>
  );
}
