// ============================================================================
// O que as telas de Fluxos precisam saber sobre a mensagem que o fluxo envia.
// Espelha as regras do motor (supabase/functions/_shared/follow-up-rules.ts):
// o que o motor recusa enviar, a tela não deixa salvar. O teste
// tests/functions/flow-messages.test.mjs confere que os dois lados concordam.
//
// Sem import de propósito: o arquivo roda direto no Node, no teste.
// ============================================================================

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM_RE = /^\d{2}:\d{2}/;

// Quantidade de variáveis diferentes ({{1}}, {{2}}, ...) no corpo do template.
function variableCount(body: string | null | undefined): number {
  return new Set((body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
}

// O fluxo preenche só a {{1}}, com o primeiro nome da pessoa. Devolve as
// variáveis que sairiam sem valor, e que por isso o motor recusa enviar.
export function unfilledFlowVariables(body: string | null | undefined): number[] {
  const missing: number[] = [];
  for (let i = 2; i <= variableCount(body); i++) missing.push(i);
  return missing;
}

export function usesNameVariable(body: string | null | undefined): boolean {
  return variableCount(body) >= 1;
}

// Horário de atendimento salvo de verdade: ao menos um dia ligado com início e
// fim. Conta que nunca salvou o horário tem {} no banco, e o follow-up dela
// continua saindo a qualquer hora.
export function hasBusinessHours(businessHours: unknown): boolean {
  if (!businessHours || typeof businessHours !== 'object') return false;
  const hours = businessHours as Record<string, unknown>;
  return DAY_KEYS.some((key) => {
    const slot = hours[key] as { enabled?: unknown; start?: unknown; end?: unknown } | null | undefined;
    if (!slot || typeof slot !== 'object') return false;
    return slot.enabled === true
      && typeof slot.start === 'string' && typeof slot.end === 'string'
      && HHMM_RE.test(slot.start) && HHMM_RE.test(slot.end);
  });
}
