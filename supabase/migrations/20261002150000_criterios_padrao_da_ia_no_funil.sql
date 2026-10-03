-- ============================================================================
-- Critérios padrão da IA nas etapas do funil
-- ----------------------------------------------------------------------------
-- A IA só move o card para etapas com critério (stages.ai_criteria), e o funil
-- que a instalação cria (20260630120000_crm_layer.sql) nascia sem critério
-- nenhum. Numa instalação nova a IA respondia o cliente e deixava o card
-- parado em "Chegou agora".
--
-- Preenche o critério das etapas com os nomes padrão, em funil comercial,
-- quando a etapa nunca teve critério (NULL). O que o dono escreveu fica como
-- está, e o critério que ele apagou na tela (texto vazio) continua apagado. A
-- etapa só recebe o texto quando o papel dela bate com o do padrão: "Fechou"
-- como etapa de ganho, "Não fechou" como etapa de perda e as outras como
-- etapas abertas. A tela cria funil novo com os mesmos textos
-- (src/lib/criterios-padrao.ts).
--
-- Instalação que aplicar esta migration passa a ter a IA movendo o card para
-- as etapas que ganharem critério. Para impedir, o dono apaga o critério da
-- etapa na tela do funil ou desliga o movimento automático no agente de IA.
-- ============================================================================

UPDATE whatsapp_hub.stages AS s
SET ai_criteria = padrao.criterio
FROM whatsapp_hub.pipelines AS p,
  (VALUES
    ('Em conversa', false, false,
     'O cliente já disse o que precisa ou fez uma pergunta sobre o produto ou o serviço, e ainda não recebeu preço nem proposta. Cumprimento sozinho, como oi ou bom dia, não conta.'),
    ('Recebeu oferta', false, false,
     'O atendimento já informou o preço, as condições de pagamento ou enviou a proposta.'),
    ('Decidindo', false, false,
     'O cliente já conhece o preço e está decidindo: pediu desconto, perguntou como pagar, disse que vai pensar ou que vai conversar com alguém.'),
    ('Fechou', true, false,
     'O cliente confirmou a compra, mandou o comprovante ou disse que já pagou.'),
    ('Não fechou', false, true,
     'O cliente disse com clareza que não quer, que desistiu ou que comprou em outro lugar.')
  ) AS padrao(nome, ganho, perdido, criterio)
WHERE p.id = s.pipeline_id
  AND p.kind = 'comercial'
  AND s.name = padrao.nome
  AND s.is_won = padrao.ganho
  AND s.is_lost = padrao.perdido
  AND s.ai_criteria IS NULL;
