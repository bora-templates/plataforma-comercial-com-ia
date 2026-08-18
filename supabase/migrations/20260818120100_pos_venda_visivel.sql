-- O funil "Pós-venda" nascia com kind='projeto', do módulo Entrega que saiu do
-- produto: nenhuma tela lista funis desse tipo, então ele existia sem aparecer.
-- Passa a ser comercial e aparece ao lado de "Vendas" em Oportunidades.
UPDATE whatsapp_hub.pipelines SET kind = 'comercial' WHERE kind = 'projeto';
