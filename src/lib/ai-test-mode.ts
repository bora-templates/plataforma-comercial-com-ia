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

// Dígitos do número já sem o zero de discagem do Brasil (0 + DDD ou 0 + código
// da operadora + DDD). Número com "+" na frente fica como está.
function aiTestDigits(text: string): string {
  let digits = text.replace(/\D/g, '');
  if (!text.startsWith('+') && digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
    // Sobrou operadora (2 dígitos) + DDD + número: tira a operadora.
    if (digits.length === 12 || digits.length === 13) digits = digits.slice(2);
  }
  return digits;
}

// DDD do Brasil: dois dígitos de 11 a 99, sem 0 em nenhum deles.
function aiTestHasBrazilianDdd(digits: string): boolean {
  return /^[1-9][1-9]/.test(digits);
}

// Chave de comparação de um número, ou null quando não é número válido.
export function allowlistPhoneKey(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();
  if (!text || text.startsWith('@')) return null;
  let digits = aiTestDigits(text);
  if (digits.length < AI_TEST_MIN_DIGITS || digits.length > AI_TEST_MAX_DIGITS) return null;
  // Sem "+", 10 ou 11 dígitos com DDD válido é número do Brasil digitado sem o 55.
  if (!text.startsWith('+') && (digits.length === 10 || digits.length === 11) && aiTestHasBrazilianDdd(digits)) {
    digits = `55${digits}`;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `55${digits.slice(2, 4)}${digits.slice(-8)}`;
  }
  return digits;
}

// Número americano digitado sem o +: 11 dígitos começando com 1 que não formam
// celular do Brasil (no celular de 11 dígitos, o terceiro é 9).
function aiTestLooksForeignWithoutPlus(text: string): boolean {
  if (text.startsWith('+')) return false;
  const digits = aiTestDigits(text);
  return digits.length === 11 && digits.startsWith('1') && digits[2] !== '9';
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
    if (aiTestLooksForeignWithoutPlus(line)) {
      return { items: [], error: 'Número de outro país começa com +.' };
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
