// Fábrica de provedores de WhatsApp. O core de reconciliação pede um provider
// pelo nome (ou deixa a config decidir) e recebe a interface — nunca o adapter
// concreto.

import { ZernioProvider } from './zernio-provider.ts';
import { UazapiProvider } from './uazapi-provider.ts';
import type { ProviderName, WhatsAppProvider } from './types.ts';

export * from './types.ts';
export { ZernioProvider } from './zernio-provider.ts';
export { UazapiProvider } from './uazapi-provider.ts';

export interface ProviderCredentials {
  zernio_api_key?: string | null;
  zernio_api_base_url?: string | null;
  uazapi_server_url?: string | null;
  uazapi_instance_token?: string | null;
}

// Constrói o provider pedido a partir das credenciais disponíveis. Retorna null
// se as credenciais desse provider não estão configuradas.
export function makeProvider(
  name: ProviderName,
  creds: ProviderCredentials,
): WhatsAppProvider | null {
  if (name === 'zernio') {
    if (!creds.zernio_api_key) return null;
    return new ZernioProvider(
      creds.zernio_api_key,
      creds.zernio_api_base_url ?? undefined,
    );
  }
  if (name === 'uazapi') {
    if (!creds.uazapi_server_url || !creds.uazapi_instance_token) return null;
    return new UazapiProvider(creds.uazapi_server_url, creds.uazapi_instance_token);
  }
  return null;
}

// Seleciona o provider correto para um webhook recebido. A rota (Fase 4) sabe
// de qual endpoint veio; como fallback, tenta Zernio (tem assinatura/estrutura
// própria) e depois Uazapi.
export function resolveInboundProvider(
  hint: ProviderName | undefined,
  creds: ProviderCredentials,
): WhatsAppProvider | null {
  if (hint) return makeProvider(hint, creds);
  return makeProvider('zernio', creds) ?? makeProvider('uazapi', creds);
}
