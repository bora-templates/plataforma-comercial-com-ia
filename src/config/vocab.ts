// Vocabulário das seções, num lugar só. Fala do trabalho comercial de qualquer
// negócio, sem jargão de CRM (nada de "pipeline", "deal", "inbox") e sem
// metáfora. Trocar aqui reflete no menu, nos títulos de página e nos textos
// que citam a seção. Chaves estáveis; só os valores mudam.
export const VOCAB = {
  dashboard:   'Painel',
  inbox:       'Conversas',
  funnel:      'Oportunidades',
  sales:       'Clientes',
  contacts:    'Pessoas',
  campaigns:   'Disparos',
  automations: 'Fluxos',
  aiAgent:     'Atendente IA',
  settings:    'Ajustes',
  orgs:        'Contas',
} as const;

// Singular/plural e artigos usados em frases correntes ("abrir a oportunidade",
// "nova pessoa"). Mantém a concordância quando o vocabulário muda.
export const VOCAB_UNIT = {
  deal:    { one: 'oportunidade', many: 'oportunidades', article: 'a' },
  contact: { one: 'pessoa',       many: 'pessoas',       article: 'a' },
  stage:   { one: 'etapa',        many: 'etapas',        article: 'a' },
} as const;
