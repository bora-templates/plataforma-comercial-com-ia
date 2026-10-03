// ============================================================================
// Critérios padrão da IA nas etapas do funil
// ----------------------------------------------------------------------------
// A IA só move o card para etapas com critério (stages.ai_criteria). Estes são
// os textos que o funil padrão traz: a migration
// 20261002150000_criterios_padrao_da_ia_no_funil.sql grava os mesmos textos no
// funil da instalação, e a tela usa esta lista ao criar um funil novo. O dono
// edita ou apaga cada critério na tela do funil.
// tests/sql/criterios-padrao-do-funil.test.mjs confere que os dois lados batem.
// ============================================================================

export const CRITERIOS_PADRAO = {
  'Em conversa':
    'O cliente já disse o que precisa ou fez uma pergunta sobre o produto ou o serviço, e ainda não recebeu preço nem proposta. Cumprimento sozinho, como oi ou bom dia, não conta.',
  'Recebeu oferta':
    'O atendimento já informou o preço, as condições de pagamento ou enviou a proposta.',
  Decidindo:
    'O cliente já conhece o preço e está decidindo: pediu desconto, perguntou como pagar, disse que vai pensar ou que vai conversar com alguém.',
  Fechou: 'O cliente confirmou a compra, mandou o comprovante ou disse que já pagou.',
  'Não fechou': 'O cliente disse com clareza que não quer, que desistiu ou que comprou em outro lugar.',
} as const;

// Etapas que a tela cria num funil novo, para ele não nascer vazio.
export function etapasDoFunilNovo(pipelineId: string) {
  return [
    { pipeline_id: pipelineId, name: 'Chegou agora', position: 0, is_won: false, is_lost: false, probability: 10, ai_criteria: null },
    { pipeline_id: pipelineId, name: 'Em conversa', position: 1, is_won: false, is_lost: false, probability: 50, ai_criteria: CRITERIOS_PADRAO['Em conversa'] },
    { pipeline_id: pipelineId, name: 'Fechou', position: 2, is_won: true, is_lost: false, probability: 100, ai_criteria: CRITERIOS_PADRAO.Fechou },
    { pipeline_id: pipelineId, name: 'Não fechou', position: 3, is_won: false, is_lost: true, probability: 0, ai_criteria: CRITERIOS_PADRAO['Não fechou'] },
  ];
}
