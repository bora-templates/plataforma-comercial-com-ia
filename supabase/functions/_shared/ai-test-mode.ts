// ============================================================================
// Modo de teste da IA (regras PURAS, sem banco nem rede).
// ----------------------------------------------------------------------------
// Com ai_agent_config.test_mode ligado, a IA só conversa com os números de
// ai_agent_config.test_allowlist. Os outros contatos seguem para o atendimento
// humano, como se a IA estivesse desligada para eles (process-ai-message).
//
// Número: compara só os dígitos.
//   · Brasil (55 + DDD + número, 12 ou 13 dígitos): casa com e sem o nono
//     dígito, pela chave 55 + DDD + 8 últimos dígitos.
//   · Digitado sem o 55 (10 ou 11 dígitos, sem "+" na frente): ganha o 55.
//   · Fora do Brasil: os dígitos inteiros.
// Instagram: o contato do Instagram não tem nome de usuário gravado no banco
// (contacts.instagram_id guarda o id do remetente que a Zernio manda), então a
// lista aceita só números e o contato do Instagram nunca casa.
//
// A tela repete a validação em src/lib/ai-test-mode.ts, e
// tests/functions/ai-test-mode.test.mjs confere que as duas concordam.
// Nomes de topo com prefixo próprio: o wizard cola este arquivo no mesmo escopo
// do index.ts (ver bundleEdgeFunction em api/bootstrap.ts).
// ============================================================================

export const AI_TEST_ALLOWLIST_MAX = 20;

const AI_TEST_MIN_DIGITS = 10;
const AI_TEST_MAX_DIGITS = 15;

export interface AiTestModeConfig {
  test_mode?: boolean | null;
  test_allowlist?: string[] | null;
}

// Chave de comparação de um número, ou null quando não é número válido.
export function allowlistPhoneKey(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();
  if (!text || text.startsWith('@')) return null;
  let digits = text.replace(/\D/g, '');
  if (digits.length < AI_TEST_MIN_DIGITS || digits.length > AI_TEST_MAX_DIGITS) return null;
  // Sem "+", 10 ou 11 dígitos é número do Brasil digitado sem o 55.
  if (!text.startsWith('+') && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `55${digits.slice(2, 4)}${digits.slice(-8)}`;
  }
  return digits;
}

// A IA pode conversar com este contato? Modo desligado (ou coluna ausente, em
// instalação que ainda não rodou a migration) libera todos.
export function aiTestModeAllows(
  config: AiTestModeConfig | null | undefined,
  contact: { phone: string | null | undefined },
): boolean {
  if (!config?.test_mode) return true;
  const contactKey = allowlistPhoneKey(contact.phone);
  if (!contactKey) return false;
  return (config.test_allowlist ?? []).some((item) => allowlistPhoneKey(item) === contactKey);
}

// Validação do campo da tela: um número por linha. Devolve os itens como foram
// digitados (sem espaço nas pontas e sem repetidos) ou a mensagem de erro.
export function validateTestAllowlist(text: string): { items: string[]; error: string | null } {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('@')) {
      return { items: [], error: 'O modo de teste vale só para números de WhatsApp. Tire o @ da lista.' };
    }
    const key = allowlistPhoneKey(line);
    if (!key) {
      return { items: [], error: `"${line}" não é um número válido. Use de 10 a 15 dígitos.` };
    }
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(line);
  }
  if (items.length > AI_TEST_ALLOWLIST_MAX) {
    return { items: [], error: `A lista aceita no máximo ${AI_TEST_ALLOWLIST_MAX} números.` };
  }
  return { items, error: null };
}
