# Changelog

Mudanças relevantes deste projeto ficam registradas aqui.

## [1.1.3] · 2026-10-28

Em Atendente IA › Agente, o modo de teste deixa a IA conversar só com uma lista de números, para
testar com os números da equipe antes de ligar a IA para os clientes.

### Atendente IA

- Seção nova "Modo de teste", logo acima de "Canais atendidos pela IA", com a caixa "Ligar o modo
  de teste" e o campo "Números liberados no teste", um número de WhatsApp por linha, até 20. A
  tela confere a lista no "Salvar alterações": cada número precisa ter de 10 a 15 dígitos.
- Com o modo ligado, a IA só responde os contatos da lista. Os outros contatos vão para o
  atendimento humano, do mesmo jeito que acontece com a IA desligada, e o `process-ai-message`
  registra o evento `ai_test_mode_skip`. Disparos, follow-ups, automações de funil e mensagens
  do time continuam como estão.
- O número casa só pelos dígitos. Número do Brasil casa com e sem o nono dígito, o zero de
  discagem no começo (011, 0 + operadora) é ignorado e o número digitado sem o 55, com DDD
  válido, vale como número do Brasil. O de outro país começa com + e compara os dígitos inteiros.
  Número americano digitado sem o + é recusado com "Número de outro país começa com +.".
- O modo de teste vale para o WhatsApp. A Plataforma não guarda o @ de quem escreve pelo
  Instagram, então com o modo ligado a IA não responde no Instagram, e a tela avisa.
- A conversa que já foi para o atendimento humano continua com o humano, mesmo depois de o
  número entrar na lista ou de o modo ser desligado. Para a IA voltar nela, clique em "Retomar
  IA" na conversa.
- Com o modo ligado, o topo da página Atendente IA mostra o selo "Modo de teste ligado".
- O modo nasce desligado nas organizações que já existem e nas novas.

### Para atualizar uma instalação que já está no ar

- Rode a migration nova `20261028120000_modo_de_teste_da_ia.sql` com `npm run db:status` e
  `npm run db:push` (seção 8 do `INSTALL.md`), ou cole o arquivo no SQL Editor.
- Republique a Edge Function `process-ai-message` com `npm run functions:deploy` (seção 2.2 do
  `INSTALL.md`). Só ela mudou.
- Atualize o código e publique na Vercel. Enquanto a migration não roda, a IA segue como antes e
  a seção do modo de teste pede para rodar a migration.

## [1.1.2] · 2026-10-28

Em Ajustes › Canais, o número desativado ganha o botão "Remover", para tirar da lista o que não
se usa mais.

### Canais

- O botão "Remover" aparece só no cartão de número desativado (Zernio e UAZAPI), ao lado de
  "Reativar", e pede confirmação antes de apagar. Número ativo não pode ser removido pela tela
  nem pela rota: ela responde 409 com "Desative o número antes de remover."
- As conversas e os disparos que passaram pelo número continuam na Plataforma, sem o vínculo com
  ele. As credenciais da Zernio não mudam. Se o número ainda estiver conectado na Zernio, é
  preciso desconectá-lo lá, senão o "Sincronizar números" traz ele de volta.
- Rota nova `api/channel-remove`, que só aceita administrador e apaga apenas na organização dele.

### Para atualizar uma instalação que já está no ar

- Basta atualizar o código e publicar na Vercel. As Edge Functions não mudaram e não precisam
  ser republicadas. Não há migration nova.

## [1.1.1] · 2026-10-27

O Instagram pela Zernio passa a funcionar quando a instalação tem mais de uma organização, e a
tela do Instagram mostra a conta que está de fato conectada.

### Canais

- O "Sincronizar números" e o "Salvar e sincronizar" guardam as contas de Instagram da Zernio
  de cada organização, junto com o número de WhatsApp. Só entram as contas do mesmo perfil da
  Zernio do número, para uma chave usada por vários clientes não levar o Instagram de um para a
  organização de outro. Quando a Zernio não diz de qual perfil é o número, nenhuma conta de
  Instagram entra e o webhook não usa esse perfil para achar a organização. Sem WhatsApp e com
  mais de um perfil na chave, a tela pede para escolher a conta do Instagram.
- O `zernio-webhook` acha a organização da DM do Instagram pela conta de Instagram e, se ela
  ainda não foi sincronizada, pelo perfil da Zernio. Antes, com duas ou mais organizações
  ativas, toda DM do Instagram era descartada.
- A conta da Zernio que tem só Instagram conecta sem erro, cadastra o webhook e avisa que nenhum
  número de WhatsApp foi encontrado.
- O card do Instagram mostra as contas sincronizadas e um botão para sincronizar. O campo de
  token saiu da tela, porque nenhum código usava o valor colado ali.
- O selo "Instagram conectado" do card da Zernio passa a olhar a conta de Instagram, e não mais
  o número de WhatsApp.

### Para atualizar uma instalação que já está no ar

- Depois de atualizar o código, republique as Edge Functions com `npm run functions:deploy`
  (seção 2.2 do `INSTALL.md`), porque o `zernio-webhook` mudou. Só então o dono clica uma vez em
  "Sincronizar números" na tela de Canais para o Instagram aparecer como conectado e as DMs
  chegarem na organização certa.
- Não há migration nova. O token de Instagram colado na tela antiga continua guardado no banco,
  sem uso.

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
