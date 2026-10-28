// Regra de remoção de um número (whatsapp_hub.channels). Mora aqui, sem I/O,
// para ser testada sem rede. O api/channel-remove.ts liga as dependências ao
// cliente admin do Supabase.
//
// Só número DESATIVADO pode ser removido. Toda busca e todo delete filtram por
// org_id, então um admin de outra organização nunca alcança a linha. As
// conversas e os disparos que usaram o número ficam (channel_id vira NULL pelo
// ON DELETE SET NULL da migration mt_schema).

export interface RemovableChannel {
  id: string;
  is_active: boolean;
}

export interface RemoveChannelDeps {
  findChannel: (orgId: string, channelId: string) => Promise<RemovableChannel | null>;
  // Devolve a mensagem de erro do banco, ou null quando apagou.
  deleteChannel: (orgId: string, channelId: string) => Promise<string | null>;
}

export interface RemoveChannelResult {
  status: number;
  body: { success: boolean; message: string };
}

export async function removeChannel(
  deps: RemoveChannelDeps,
  input: { orgId: string; channelId: string },
): Promise<RemoveChannelResult> {
  const channelId = input.channelId.trim();
  if (!channelId) {
    return { status: 400, body: { success: false, message: 'Informe o número a remover.' } };
  }
  const channel = await deps.findChannel(input.orgId, channelId);
  if (!channel) {
    return { status: 404, body: { success: false, message: 'Número não encontrado.' } };
  }
  if (channel.is_active) {
    return { status: 409, body: { success: false, message: 'Desative o número antes de remover.' } };
  }
  const error = await deps.deleteChannel(input.orgId, channelId);
  if (error) {
    return { status: 500, body: { success: false, message: error } };
  }
  return { status: 200, body: { success: true, message: 'Número removido.' } };
}
