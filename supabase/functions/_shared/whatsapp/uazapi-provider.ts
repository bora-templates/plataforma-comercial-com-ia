// UazapiProvider — API Não Oficial (Baileys/Whatsmeow). Payload padrão Baileys:
//   { event, instance, data|message: {
//       key: { remoteJid, fromMe, id, participant? },
//       message: { conversation } | { extendedTextMessage:{text} }
//              | { imageMessage:{caption,url} } | { audioMessage } | ...,
//       messageTimestamp, pushName } }
// (marcado ASSUMIDO — confirmar no 1º teste de integração real.)
//
// NÃO entrega referral/ctwa_clid: apps não-oficiais não têm acesso a esse
// metadado do Meta. extractReferral SEMPRE retorna null — a atribuição CTWA
// aqui depende do código de rastreio no texto (tratado no core da Fase 4).

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

// remoteJid: "5511999998888@s.whatsapp.net" (1:1) ou "...@g.us" (grupo).
function jidToPhone(jid: string | null): string | null {
  if (!jid) return null;
  const bare = jid.split(/[:@]/)[0];
  if (!/^\d{6,}$/.test(bare)) return null;
  return normalizePhone(bare);
}

function decodeUazapiContent(msg: Record<string, unknown>): {
  contentType: NormalizedInbound['contentType'];
  content: string | null;
  mediaUrl: string | null;
} {
  if (typeof msg.conversation === 'string') {
    return { contentType: 'text', content: msg.conversation, mediaUrl: null };
  }
  const ext = asObject(msg.extendedTextMessage);
  if (typeof ext.text === 'string') {
    return { contentType: 'text', content: ext.text, mediaUrl: null };
  }
  const image = asObject(msg.imageMessage);
  if (Object.keys(image).length) {
    return { contentType: 'image', content: str(image, ['caption']), mediaUrl: str(image, ['url', 'directPath']) };
  }
  const video = asObject(msg.videoMessage);
  if (Object.keys(video).length) {
    return { contentType: 'video', content: str(video, ['caption']), mediaUrl: str(video, ['url', 'directPath']) };
  }
  const audio = asObject(msg.audioMessage);
  if (Object.keys(audio).length) {
    return { contentType: 'audio', content: null, mediaUrl: str(audio, ['url', 'directPath']) };
  }
  const doc = asObject(msg.documentMessage);
  if (Object.keys(doc).length) {
    return { contentType: 'document', content: str(doc, ['caption', 'fileName']), mediaUrl: str(doc, ['url', 'directPath']) };
  }
  return { contentType: 'text', content: null, mediaUrl: null };
}

export class UazapiProvider implements WhatsAppProvider {
  readonly name = 'uazapi' as const;
  private readonly serverUrl: string;
  private readonly instanceToken: string;

  constructor(serverUrl: string, instanceToken: string) {
    this.serverUrl = serverUrl;
    this.instanceToken = instanceToken;
  }

  parseInboundWebhook(rawPayload: unknown): NormalizedInbound | null {
    const root = asObject(rawPayload);

    // Eventos que não são mensagem (connection/presence/status) → ignora.
    const evt = (str(root, ['event', 'EventType', 'type']) ?? '').toLowerCase();
    if (evt && !/^messages?$/.test(evt)) return null;

    // Shape REAL da uazapi v2: o objeto Message FLAT { messageid, chatid,
    // sender, sender_pn, senderName, isGroup, fromMe, messageType, text,
    // messageTimestamp, wasSentByApi, fileURL, ... } chega ora em `root.message`
    // (EventType 'messages' — servidor atual), ora em `root.data`, ora aninhado
    // em `root.data.message`. Procuramos onde estão os campos de mensagem.
    const data = asObject(root.data);
    const flat = [data, asObject(root.message), asObject(data.message)].find(
      (o) => o.messageid || o.sender || o.sender_pn || o.chatid,
    ) ?? null;
    if (flat) {
      const messageId = str(flat, ['messageid', 'id']);
      if (!messageId) return null;
      const from =
        jidToPhone(str(flat, ['sender_pn', 'sender'])) ??
        (flat.isGroup !== true ? jidToPhone(str(flat, ['chatid'])) : null);
      if (!from) return null;

      const mtype = (str(flat, ['messageType', 'type']) ?? '').toLowerCase();
      const mediaUrl = str(flat, ['fileURL', 'fileUrl', 'file_url']);
      const contentType: NormalizedInbound['contentType'] = /image|sticker/.test(mtype)
        ? 'image'
        : /audio|ptt|voice/.test(mtype)
          ? 'audio'
          : /video/.test(mtype)
            ? 'video'
            : /document|file/.test(mtype)
              ? 'document'
              : 'text';

      return {
        from,
        text: str(flat, ['text', 'caption']),
        messageId,
        timestamp: toIso(flat.messageTimestamp),
        isFromMe: flat.fromMe === true || flat.wasSentByApi === true,
        raw: rawPayload,
        contentType,
        mediaUrl: mediaUrl ?? null,
        conversationId: str(flat, ['chatid']),
        senderName: str(flat, ['senderName', 'pushName']),
      };
    }

    // Fallback: shape Baileys clássico (data.key.remoteJid...) — mantido para
    // servidores uazapi antigos/compatíveis.
    const container =
      asObject(root.data).key || asObject(root.data).message
        ? asObject(root.data)
        : root.message
          ? asObject(root.message)
          : Array.isArray(root.messages)
            ? asObject(root.messages[0])
            : root;

    const key = asObject(container.key);
    const messageId = str(key, ['id']) ?? str(container, ['id']);
    if (!messageId) return null;

    const remoteJid = str(key, ['remoteJid']);
    const participant = str(key, ['participant']);
    const isGroup = (remoteJid ?? '').endsWith('@g.us');
    // Em grupo o remetente real é o participant; em 1:1 é o remoteJid.
    const from = jidToPhone(isGroup ? participant : remoteJid) ?? jidToPhone(participant);
    if (!from) return null;

    const { contentType, content, mediaUrl } = decodeUazapiContent(asObject(container.message));

    return {
      from,
      text: content,
      messageId,
      timestamp: toIso(container.messageTimestamp ?? container.t),
      isFromMe: key.fromMe === true,
      raw: rawPayload,
      contentType,
      mediaUrl,
      conversationId: remoteJid,
      senderName: str(container, ['pushName', 'notifyName']),
    };
  }

  // Uazapi/Baileys nunca carrega o ctwa_clid do Meta.
  extractReferral(_rawPayload: unknown): Referral | null {
    return null;
  }

  // POST {serverUrl}/send/text {number,text} · /send/media {number,type,file,text}
  // — header `token` da instância (confirmado na spec OpenAPI da uazapi).
  async sendMessage(to: string, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const number = to.replace(/\D/g, '');
    try {
      const path = opts.mediaUrl ? '/send/media' : '/send/text';
      const mediaType = ['image', 'video', 'audio', 'document'].includes(opts.mediaType ?? '')
        ? opts.mediaType
        : 'document';
      const res = await fetch(`${this.serverUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { token: this.instanceToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          opts.mediaUrl ? { number, type: mediaType, file: opts.mediaUrl, text } : { number, text },
        ),
      });
      const body = await res.json().catch(() => ({}));
      const messageId =
        str(asObject(body), ['id', 'messageId']) ?? str(asObject(asObject(body).key), ['id']);
      return { ok: res.ok, messageId, raw: body, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, messageId: null, raw: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
