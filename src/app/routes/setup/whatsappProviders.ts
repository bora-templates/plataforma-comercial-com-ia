// Regras de validação dos provedores de WhatsApp no Step 4 do wizard (Fase 2).
// Os dois provedores coexistem e são individualmente OPCIONAIS, mas o step só
// avança se PELO MENOS UM estiver completo.
//   - Zernio (API Oficial): basta a zernio_api_key.
//   - Uazapi (API Não Oficial): exige server URL + instance token (o par).

export const WHATSAPP_PROVIDER_KEYS = {
  zernio: ['zernio_api_key'] as const,
  uazapi: ['uazapi_server_url', 'uazapi_instance_token'] as const,
};

export const NO_WHATSAPP_PROVIDER_MESSAGE =
  'Configure pelo menos um provedor de WhatsApp para continuar.';

// Um provedor está completo quando TODAS as suas chaves têm valor não-vazio e
// passaram na validação server-side (mapa validation[key] === true).
export function providerComplete(
  keys: readonly string[],
  values: Record<string, string | undefined>,
  validation: Record<string, boolean | undefined>,
): boolean {
  return keys.every(
    (k) => (values[k]?.trim() ?? '') !== '' && validation[k] === true,
  );
}

export function hasZernioProvider(
  values: Record<string, string | undefined>,
  validation: Record<string, boolean | undefined>,
): boolean {
  return providerComplete(WHATSAPP_PROVIDER_KEYS.zernio, values, validation);
}

export function hasUazapiProvider(
  values: Record<string, string | undefined>,
  validation: Record<string, boolean | undefined>,
): boolean {
  return providerComplete(WHATSAPP_PROVIDER_KEYS.uazapi, values, validation);
}

export function hasAtLeastOneWhatsAppProvider(
  values: Record<string, string | undefined>,
  validation: Record<string, boolean | undefined>,
): boolean {
  return (
    hasZernioProvider(values, validation) || hasUazapiProvider(values, validation)
  );
}
