// ============================================================================
// _shared/follow-up-rules.ts: regras de decisão do motor de follow-up
// ----------------------------------------------------------------------------
// Módulo PURO: sem banco, sem rede, sem Deno. Recebe os dados e o relógio e
// devolve a decisão. check-follow-ups e funnel-automation fazem as consultas e
// o envio, e perguntam aqui o que fazer. Por ser puro, roda direto no Node:
//   npm run test:functions   (tests/functions/follow-up-rules.test.mjs)
//
// O que mora aqui:
//   · horário de atendimento da conta (aberto, fechado ou não configurado)
//   · ordem das regras (conta, sequence_order, regra mais antiga)
//   · janela de inatividade (espera da regra, data em que ela foi ligada e teto)
//   · quem fica fora: conversa fechada, conversa com o time, lead esperando resposta
//   · primeiro nome da pessoa, {nome} no texto livre e variáveis {{n}} de template
//
// ATENÇÃO ao bundler do wizard (api/bootstrap.ts): ele cola este arquivo no
// MESMO escopo do index.ts da função. Todo nome de topo daqui precisa ser único
// no bundle, e nenhum comentário pode parecer um import relativo.
// ============================================================================

// ---- Horário de atendimento ---------------------------------------------------
// Mesma leitura de process-ai-message (buildScheduleVars): o dia precisa estar
// ligado e a hora atual, no fuso da conta, entre início e fim (limites entram).
// Diferença deliberada: conta sem nenhum dia válido devolve 'unconfigured', e o
// motor mantém o envio a qualquer hora, como era antes desta trava.

export type BusinessHoursStatus = 'open' | 'closed' | 'unconfigured';

const FOLLOW_UP_DEFAULT_TZ = 'America/Sao_Paulo';
const FOLLOW_UP_DAY_KEYS: Record<string, string> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
};
const HHMM_RE = /^\d{2}:\d{2}/;

function zonedClock(tz: string, now: Date): { day: string; hhmm: string } {
  // hourCycle h23: meia-noite sai como "00", nunca "24".
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: FOLLOW_UP_DAY_KEYS[pick('weekday')] ?? 'mon', hhmm: `${pick('hour')}:${pick('minute')}` };
}

function validDaySlot(slot: unknown): { start: string; end: string } | null {
  if (!slot || typeof slot !== 'object') return null;
  const s = slot as { enabled?: unknown; start?: unknown; end?: unknown };
  if (s.enabled !== true) return null;
  if (typeof s.start !== 'string' || typeof s.end !== 'string') return null;
  if (!HHMM_RE.test(s.start) || !HHMM_RE.test(s.end)) return null;
  return { start: s.start.slice(0, 5), end: s.end.slice(0, 5) };
}

export function businessHoursStatus(
  businessHours: unknown,
  tz: string | null | undefined,
  now: Date,
): BusinessHoursStatus {
  if (!businessHours || typeof businessHours !== 'object') return 'unconfigured';
  const hours = businessHours as Record<string, unknown>;
  const configured = Object.values(FOLLOW_UP_DAY_KEYS).some((key) => validDaySlot(hours[key]));
  if (!configured) return 'unconfigured';

  let clock: { day: string; hhmm: string };
  try {
    clock = zonedClock(tz?.trim() || FOLLOW_UP_DEFAULT_TZ, now);
  } catch {
    clock = zonedClock(FOLLOW_UP_DEFAULT_TZ, now); // fuso inválido no cadastro
  }
  const today = validDaySlot(hours[clock.day]);
  if (!today) return 'closed';
  return today.start <= clock.hhmm && clock.hhmm <= today.end ? 'open' : 'closed';
}

// ---- Ordem das regras -----------------------------------------------------------
// A cadência é uma sequência (toque 1, 2, 3). Sem ordem, a regra de encerramento
// podia ser a primeira a alcançar a conversa. Como cada envio zera o relógio da
// conversa, a regra de menor sequence_order precisa olhar primeiro.

export interface OrderableRule {
  org_id: string;
  sequence_order: number;
  created_at?: string | null;
}

export function orderRules<T extends OrderableRule>(rules: T[]): T[] {
  return [...rules].sort((a, b) =>
    a.org_id.localeCompare(b.org_id)
    || a.sequence_order - b.sequence_order
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

// ---- Janela de inatividade ------------------------------------------------------
// A conversa entra quando a última mensagem dela cai entre `oldest` e `newest`:
//   newest = agora - delay_hours (já esperou o tempo da regra)
//   oldest = o mais recente entre a data em que a regra foi ligada (criada ou
//            religada, que é quando updated_at muda) e o teto de inatividade.
// A data da regra impede que a primeira ativação dispare para o histórico
// inteiro. O teto impede que uma conversa esquecida há meses receba follow-up
// quando volta a casar com a regra (filtro que mudou, conversa devolvida à IA).

export const MAX_EXTRA_IDLE_HOURS = 168; // 7 dias além da espera da regra

export interface IdleWindow {
  oldest: string;
  newest: string;
}

export interface WindowRule {
  delay_hours: number;
  created_at?: string | null;
  updated_at?: string | null;
}

const HOUR_MS = 3600 * 1000;

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function inactivityWindow(rule: WindowRule, now: Date): IdleWindow | null {
  const newest = now.getTime() - rule.delay_hours * HOUR_MS;
  const cap = newest - MAX_EXTRA_IDLE_HOURS * HOUR_MS;
  const activeSince = Math.max(parseInstant(rule.created_at) ?? 0, parseInstant(rule.updated_at) ?? 0);
  const oldest = Math.max(cap, activeSince);
  if (oldest > newest) return null; // regra ligada há menos tempo que a própria espera
  return { oldest: new Date(oldest).toISOString(), newest: new Date(newest).toISOString() };
}

// ---- Quem fica fora ---------------------------------------------------------------

export type SkipReason = 'closed' | 'human' | 'outside_window' | 'no_messages' | 'waiting_reply';

// A regra só alcança conversa que está com uma pessoa do time quando declara
// params.include_human_active = true (booleano de verdade, string não vale).
export function includesHumanConversations(params: unknown): boolean {
  return Boolean(params) && typeof params === 'object'
    && (params as Record<string, unknown>).include_human_active === true;
}

export interface ConversationState {
  status: string | null;
  ai_paused: boolean | null;
  last_message_at: string | null;
}

// A consulta do motor já filtra por estes critérios. Esta função repete a
// decisão em cima de cada linha devolvida, então um filtro esquecido na consulta
// não vira mensagem enviada.
export function conversationSkipReason(
  conv: ConversationState,
  window: IdleWindow,
  includeHuman: boolean,
): SkipReason | null {
  if (conv.status === 'closed') return 'closed';
  if (!includeHuman && (conv.status === 'human_active' || conv.ai_paused === true)) return 'human';
  const last = parseInstant(conv.last_message_at);
  const oldest = parseInstant(window.oldest);
  const newest = parseInstant(window.newest);
  if (last === null || oldest === null || newest === null) return 'outside_window';
  if (last < oldest || last > newest) return 'outside_window';
  return null;
}

// Última mensagem não privada da conversa. Se foi o lead quem falou por último,
// ele está esperando resposta, e um "conseguiu ver minha mensagem?" só piora.
export function lastMessageSkipReason(last: { direction: string } | null): SkipReason | null {
  if (!last) return 'no_messages';
  return last.direction === 'outbound' ? null : 'waiting_reply';
}

// ---- Nome da pessoa ----------------------------------------------------------------
// Primeiro nome a partir de contacts.name. O nome vem do perfil do WhatsApp ou de
// uma planilha, então pode chegar com emoji, telefone no lugar do nome ou
// tratamento na frente. O que não tem letra não é nome, e devolve ''.

const NAME_EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const HAS_LETTER_RE = /\p{L}/u;
const HONORIFIC_RE = /^(dr|dra|sr|sra|prof|profa)$/i;

export function firstNameOf(name: string | null | undefined): string {
  const tokens = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(NAME_EDGE_RE, ''))
    .filter((token) => HAS_LETTER_RE.test(token));
  if (tokens.length === 0) return '';
  if (tokens.length > 1 && HONORIFIC_RE.test(tokens[0])) return tokens[1];
  return tokens[0];
}

// ---- Texto livre --------------------------------------------------------------------
// {nome} vira o primeiro nome. Sem nome, o marcador sai junto com a vírgula que o
// acompanha ("Oi, {nome}! Tudo certo?" vira "Oi! Tudo certo?"), e a linha que
// começava pelo nome volta a começar com maiúscula.

const NAME_TOKEN_RE = /\{nome\}/gi;

export function renderFreeText(text: string, firstName: string): string {
  if (!/\{nome\}/i.test(text)) return text;
  if (firstName) return text.replace(NAME_TOKEN_RE, firstName);
  return text
    .replace(/[ \t]*,?[ \t]*\{nome\}/gi, '')
    .replace(/(^|\n)[ \t]*[,;:.!?]+[ \t]*(\S)/g, (_m, lineBreak: string, ch: string) => lineBreak + ch.toUpperCase());
}

// ---- Variáveis de template -----------------------------------------------------------
// Parâmetro vazio nunca sai: a Meta recusa o envio ("Required parameter is
// missing") ou entrega a frase quebrada. O que o fluxo sabe preencher:
//   {{1}}       → primeiro nome da pessoa (ou o nome reserva da regra)
//   {{n}} fixo  → valor gravado em template_params / action.params (aceita {nome})
// Qualquer outra variável devolve ok:false, e quem chamou não envia.

export function countVariables(body: string): number {
  return new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
}

export function renderPreview(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_w, n: string) => params[Number(n) - 1] ?? `{{${n}}}`);
}

function fixedParamAt(explicit: unknown, index: number): string {
  if (!Array.isArray(explicit)) return '';
  const raw = explicit[index - 1];
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
}

export type TemplateParamsResult =
  | { ok: true; values: string[] }
  | { ok: false; reason: 'unmapped' | 'missing_name'; index: number };

export function resolveTemplateParams(
  body: string,
  explicit: unknown,
  firstName: string,
  nameFallback?: unknown,
): TemplateParamsResult {
  const name = firstName || (typeof nameFallback === 'string' ? nameFallback.trim() : '');
  const values: string[] = [];
  const total = countVariables(body);
  for (let i = 1; i <= total; i++) {
    const fixed = fixedParamAt(explicit, i);
    if (fixed) {
      const usesName = /\{nome\}/i.test(fixed);
      if (usesName && !name) return { ok: false, reason: 'missing_name', index: i };
      values.push(usesName ? fixed.replace(NAME_TOKEN_RE, name) : fixed);
    } else if (i === 1) {
      if (!name) return { ok: false, reason: 'missing_name', index: 1 };
      values.push(name);
    } else {
      return { ok: false, reason: 'unmapped', index: i };
    }
  }
  return { ok: true, values };
}

// Variáveis que a regra nunca vai conseguir preencher, para recusar a regra
// inteira uma vez só em vez de falhar contato por contato.
export function unfillableVariables(body: string, explicit: unknown): number[] {
  const missing: number[] = [];
  for (let i = 2; i <= countVariables(body); i++) {
    if (!fixedParamAt(explicit, i)) missing.push(i);
  }
  return missing;
}
