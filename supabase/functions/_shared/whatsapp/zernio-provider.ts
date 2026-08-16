// ZernioProvider — API Oficial (Cloud API via Zernio). Único caminho que pode
// entregar o referral/ctwa_clid das mensagens vindas de CTWA ads.
//
// O shape do inbound segue o que o zernio-webhook já normaliza:
//   data = { message: { id, sender:{name,phoneNumber,id}, text|body|caption,
//                        attachments:[{type,url}], referral?/context?, platform,
//                        conversationId },
//            conversation: { id, participantName, participantId } }
// (marcado ASSUMIDO no restante do código — tolerante a variações de campo.)

import {
  asObject,
  normalizePhone,
  str,
  toIso,
  type NormalizedInbound,
  type Referral,
  type SendOptions,
  type SendResult,
  type WhatsAppProvider,
} from './types.ts';

function decodeZernioContent(message: Record<string, unknown>): {
  contentType: NormalizedInbound['contentType'];
  content: string | null;
  mediaUrl: string | null;
} {
  const text = str(message, ['text', 'body', 'caption']);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const first = asObject(attachments[0]);
  const mediaUrl = str(first, ['url', 'link', 'href']);
  const type = (str(first, ['type']) ?? '').toLowerCase();
  if (!mediaUrl) return { contentType: 'text', content: text ?? '', mediaUrl: null };
  switch (type) {
    case 'image':
    case 'sticker':
      return { contentType: 'image', content: text, mediaUrl };
    case 'audio':
    case 'voice':
      return { contentType: 'audio', content: null, mediaUrl };
    case 'video':
      return { contentType: 'video', content: text, mediaUrl };
    default:
      return { contentType: 'document', content: text, mediaUrl };
  }
}

export class ZernioProvider implements WhatsAppProvider {
  readonly name = 'zernio' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://zernio.com/api/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  parseInboundWebhook(rawPayload: unknown): NormalizedInbound | null {
    const root = asObject(rawPayload);
    const type = str(root, ['type', 'event', 'eventType']) ?? '';
    // Só mensagens inbound interessam à reconciliação.
    if (type && !type.startsWith('message.received') && type !== 'message') return null;

    const data = root.data ? asObject(root.data) : root;
    const message = asObject(data.message ?? data);
    const conversation = asObject(data.conversation);
    const sender = asObject(message.sender);

    const messageId = str(message, ['id', '_id', 'messageId']);
    if (!messageId) return null;

    const from =
      str(sender, ['phoneNumber']) ??
      normalizePhone(str(sender, ['id'])) ??
      normalizePhone(str(conversation, ['participantId'])) ??
      '';
    if (!from) return null;

    const { contentType, content, mediaUrl } = decodeZernioContent(message);

    return {
      from,
      text: content,
      messageId,
      timestamp: toIso(message.timestamp ?? message.createdAt ?? data.statusAt),
      isFromMe: message.fromMe === true || message.direction === 'outbound',
      raw: rawPayload,
      contentType,
      mediaUrl,
      conversationId: str(conversation, ['id']) ?? str(message, ['conversationId']),
      senderName: str(sender, ['name']) ?? str(conversation, ['participantName']),
    };
  }

  // Cloud API põe o referral no objeto da mensagem quando o usuário chegou por
  // um anúncio CTWA. Zernio pode aninhar em message.referral, message.context
  // .referral ou data.referral — tentamos as três.
  extractReferral(rawPayload: unknown): Referral | null {
    const root = asObject(rawPayload);
    const data = root.data ? asObject(root.data) : root;
    const message = asObject(data.message ?? data);
    const referral =
      (message.referral && asObject(message.referral)) ||
      (asObject(message.context).referral && asObject(asObject(message.context).referral)) ||
      (data.referral && asObject(data.referral)) ||
      null;
    if (!referral) return null;
    const ctwa = str(referral, ['ctwa_clid', 'ctwaClid', 'click_id']);
    if (!ctwa) return null;
    return {
      ctwa_clid: ctwa,
      source_id: str(referral, ['source_id', 'sourceId', 'ad_id', 'adId']),
      headline: str(referral, ['headline', 'title']),
    };
  }

  // POST /inbox/conversations/{conversationId}/messages — envio 1:1.
  // Para Zernio, `to` é o conversationId (ou opts.conversationId). ASSUMIDO.
  async sendMessage(to: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const conversationId = opts.conversationId ?? to;
    try {
      const res = await fetch(
        `${this.baseUrl}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            opts.mediaUrl ? { text, attachmentUrl: opts.mediaUrl } : { text },
          ),
        },
      );
      const body = await res.json().catch(() => ({}));
      const messageId = str(asObject(body), ['id', '_id', 'messageId']);
      return { ok: res.ok, messageId, raw: body, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, messageId: null, raw: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
