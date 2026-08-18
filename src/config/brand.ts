// Marca em um lugar só. O template que o aluno clona vem com os valores neutros
// abaixo; cada instalação troca aqui e no logo em
// public/brand-mark.png, sem caçar string espalhada por componente.
export const BRAND = {
  /** Assinatura de quem opera a instalação, acima do nome do produto.
      Deixe vazio para mostrar só o produto. */
  owner: '',
  /** Nome do produto. É o que ganha o destaque visual na sidebar e no login. */
  product: 'Plataforma Comercial',
  /** Arquivo em public/. Troque a imagem mantendo o nome. */
  mark: '/brand-mark.png',
  /** Usado no <title> e no prompt padrão do agente. */
  companyName: 'Plataforma Comercial',
} as const;
