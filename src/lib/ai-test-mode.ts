// ============================================================================
// Modo de teste da IA na tela Atendente IA › Agente.
// Espelha a validação do motor (supabase/functions/_shared/ai-test-mode.ts):
// o que o motor não consegue casar, a tela não deixa salvar. O teste
// tests/functions/ai-test-mode.test.mjs confere que os dois lados concordam.
//
// Sem import de propósito: o arquivo roda direto no Node, no teste.
// ============================================================================

export const AI_TEST_ALLOWLIST_MAX = 20;

const AI_TEST_MIN_DIGITS = 10;
const AI_TEST_MAX_DIGITS = 15;

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
