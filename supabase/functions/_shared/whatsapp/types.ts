// ============================================================================
// Camada agnóstica de provedor de WhatsApp (Fase 3)
// ----------------------------------------------------------------------------
// O core de reconciliação (Fase 4) consome SÓ esta interface — nunca conhece o
// formato bruto de cada provedor. Adicionar/trocar provedor = escrever um
// adapter novo, sem tocar no core.
//
// parseInboundWebhook / extractReferral são PUROS (sem I/O, sem Deno API) para
// serem testáveis em Node e reutilizáveis em qualquer runtime.
// ============================================================================

export type ProviderName = 'zernio' | 'uazapi';

// Contrato único de mensagem inbound, normalizado a partir do payload bruto de
// cada provedor (Zernio Cloud-API-shape vs Uazapi Baileys-shape).
export interface NormalizedInbound {
  from: string;          // identidade do remetente (E.164 quando WhatsApp)
  text: string | null;   // corpo textual (null p/ mídia sem legenda)
  messageId: string;     // id estável da mensagem (idempotência)
  timestamp: string | null; // ISO-8601 quando disponível
  isFromMe: boolean;     // true = mensagem enviada pela própria conta (echo)
  raw: unknown;          // payload cru, para auditoria/reprocesso
  // Extras opcionais (úteis à ingestão; fora do contrato mínimo da spec):
  contentType?: 'text' | 'image' | 'audio' | 'video' | 'document';
  mediaUrl?: string | null;
  conversationId?: string | null;
  senderName?: string | null;
}

// Objeto referral do Click-to-WhatsApp (CTWA). Só o caminho oficial (Zernio
// sobre Cloud API) consegue entregá-lo; provedores não-oficiais retornam null.
export interface Referral {
  ctwa_clid: string;
  source_id: string | null;
  headline: string | null;
}

export interface SendOptions {
  conversationId?: string;   // Zernio envia 1:1 por conversationId
  mediaUrl?: string | null;
  mediaType?: string;        // image | video | audio | document (uazapi /send/media)
}

export interface SendResult {
  ok: boolean;
  messageId: string | null;
  raw: unknown;
  error?: string;
}

export interface WhatsAppProvider {
  readonly name: ProviderName;
  sendMessage(to: string, text: string, opts?: SendOptions): Promise<SendResult>;
  parseInboundWebhook(rawPayload: unknown): NormalizedInbound | null;
  extractReferral(rawPayload: unknown): Referral | null;
}

// ---- helpers de leitura tolerante (compartilhados pelos adapters) ----------

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return t.startsWith('+') ? t : `+${t}`;
}

// Converte epoch (s ou ms) ou string ISO em ISO-8601; null se indeterminado.
export function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number' && isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value; // epoch s → ms
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
