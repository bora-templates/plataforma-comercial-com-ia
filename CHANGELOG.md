# Changelog

Mudanças relevantes deste projeto ficam registradas aqui.

## [1.1.0] · 2026-10-02

O card passa a nascer sozinho no funil, a IA já vem pronta para mover o card e a organização
nova nasce com funil. As correções feitas em 18 e 19/09 entraram no modelo publicado junto com
esta versão.

### Funil e IA

- O card nasce no funil quando chega a primeira mensagem de um contato novo pelo WhatsApp ou
  pelo Instagram, na organização do contato.
- O contato com card perdido há mais de 7 dias que volta a falar ganha card novo, e quem já
  comprou não ganha card automático.
- O formulário da página cria o card na organização da página, informada pelo atributo
  `data-org` do `ah-tracker.js` ou pelo código do link rastreado.
- O funil padrão vem com os critérios que deixam a IA mover o card, e o funil novo criado na
  tela também.
- A organização criada em Contas nasce com os funis "Vendas" e "Pós-venda", e as organizações
  ativas que estavam sem funil recebem os dois na atualização.

### Canais e follow-up

- O número oficial da Zernio aparece na tela de Canais, e o botão "Sincronizar números" traz um
  número novo sem colar a chave de novo.
- O `zernio-webhook` acha a organização pela conta da Zernio quando há mais de uma organização
  ativa.
- O assistente de instalação deixou de publicar um `zernio-webhook` quebrado, que tinha um nome
  declarado duas vezes.
- O follow-up respeita o horário de atendimento, a ordem das mensagens e quem falou por último,
  e preenche as variáveis do texto.

### Segurança e banco

- O convite de equipe só é criado pelo backend, e o cadastro aberto fica desligado na instalação.
- As funções que criam card e as que preparam a organização nova só podem ser chamadas pelo
  servidor.
- O `npm run db:push` reconhece as migrations que o assistente aplicou e para sem escrever nada
  quando o banco parece instalado sem registro. O `npm run db:status` mostra o que falta sem
  escrever nada.

### Documentação

- O README explica as telas, a montagem, a instalação, o desenvolvimento, as migrations e os
  testes.
- O `CLAUDE.md` e o `AGENTS.md` registram as travas do follow-up e a regra do bundler do
  assistente.

### Para atualizar uma instalação que já está no ar

- Quem conectou a Zernio antes desta versão clica uma vez em "Sincronizar números" na tela de
  Canais para o número aparecer.
- A IA passa a mover o card para as etapas que ganharem critério. Para impedir numa etapa, o
  dono apaga o critério dela na tela do funil. Para desligar tudo, ele desmarca "Mover as pessoas
  pelas etapas automaticamente" em Atendente IA, aba Agente.

## [1.0.1] · 2026-08-19

Esta versão reúne os ajustes de 17 a 19/08, com as correções do teste completo da plataforma no
navegador.

- As seções e o corpo das telas usam vocabulário de negócio (Conversas, Oportunidades,
  Pessoas, Disparos, Fluxos e Atendente IA), definido em `src/config/vocab.ts`.
- Os textos do painel falam a língua do negócio.
- O convite de equipe gera um link para copiar e enviar, sem depender de e-mail.
- O assistente de instalação orienta o uso das chaves Legacy do Supabase.
- Fechar uma oportunidade não dá mais erro, porque os gatilhos de venda agora respeitam a
  organização.
- Os menus do cabeçalho deixaram de ficar atrás dos cards, o ranking mostra o nome do operador
  e os canais orgânicos e diretos ganharam rótulos próprios.
- O modelo ganhou ícone próprio, e a marca aceita a assinatura opcional de quem opera a
  instalação.
- Os textos da interface, das mensagens, do prompt padrão do agente e da documentação ficaram
  sem travessão.

## [1.0.0] · 2026-08-16

Primeira versão do template de instalação.

- Inbox multicanal: WhatsApp (API oficial via Zernio e UAZAPI) e Instagram
- Funil comercial personalizável, com a IA movendo os leads
- Agente de IA de atendimento com base de conhecimento, mídias e follow-up
- Campanhas em massa com templates aprovados pela Meta
- Rastreamento de origem por UTM com link redirecionador
- Vendas e recompra com lembrete automático
- Múltiplas organizações isoladas na mesma instalação
- Assistente de instalação em `/setup`
