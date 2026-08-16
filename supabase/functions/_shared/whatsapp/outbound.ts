// Envio outbound via Uazapi para conversas do canal 'uazapi'. Permite WABA
// (Zernio) e Uazapi coexistirem: cada conversa responde pelo provedor por onde
// a mensagem chegou; as credenciais dos dois podem estar configuradas juntas.

import { getCredential } from '../credentials.ts';
import { UazapiProvider } from './uazapi-provider.ts';

export async function loadUazapiProvider(): Promise<UazapiProvider> {
  const serverUrl = ((await getCredential('uazapi_server_url')) ?? '').replace(/\/$/, '');
  const token = (await getCredential('uazapi_instance_token')) ?? '';
  if (!serverUrl || !token) {
    throw new Error('Credenciais Uazapi ausentes (server URL / instance token).');
  }
  return new UazapiProvider(serverUrl, token);
}

// Envia texto (e opcionalmente mídia) para o telefone do contato via Uazapi.
export async function sendUazapiMessage(
  phone: string,
  text: string,
  mediaUrl?: string | null,
  mediaType?: string,
): Promise<{ messageId: string | null }> {
  const provider = await loadUazapiProvider();
  const result = await provider.sendMessage(phone, text, { mediaUrl: mediaUrl ?? undefined, mediaType });
  if (!result.ok) {
    throw new Error(result.error ?? 'Erro ao enviar via Uazapi.');
  }
  return { messageId: result.messageId };
}
