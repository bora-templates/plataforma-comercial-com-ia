# Plataforma Comercial com IA

A Plataforma Comercial com IA é um CRM com atendente de IA, WhatsApp, Instagram e funil
comercial. Cada instalação roda na infraestrutura de quem instala: o banco e as funções ficam
no Supabase, e as telas ficam na Vercel. O código é seu, e você pode adaptar a plataforma ao
seu negócio sem pedir licença a ninguém.

Esta versão aceita várias organizações na mesma instalação. Cada organização tem os próprios
funis, canais, credenciais, equipe e atendente de IA, e o banco separa os dados de cada uma.

## O que a plataforma faz

| Tela | O que ela faz |
|---|---|
| Conversas | Reúne WhatsApp e Instagram numa caixa de entrada só. A equipe responde com texto, mídia e template, escreve notas internas e assume a conversa quando a IA transfere. |
| Atendente IA | Responde pelo WhatsApp e pelo Instagram com a base de conhecimento, as mídias cadastradas e o horário de atendimento. Funciona com OpenAI, Claude ou Gemini, entende áudio e imagem e transfere para a equipe quando precisa. |
| Oportunidades | Mostra os funis, as etapas, a chance de fechamento de cada etapa e o critério que a IA usa para mover o card. O card nasce sozinho na primeira mensagem de um contato novo e no formulário da página. |
| Clientes | Registra as vendas e lembra a recompra no prazo de cada produto. |
| Pessoas | Guarda os contatos com a origem de cada um: UTM, anúncio de clique para o WhatsApp ou link rastreado. |
| Disparos | Envia campanhas em massa com templates aprovados pela Meta. |
| Fluxos | Roda regras sozinhas, com ações quando o card entra numa etapa e follow-up por inatividade, falta de resposta ou falta de compra. |
| Painel | Mostra como está o comercial agora, com os indicadores que cada organização escolhe. |
| Ajustes | Reúne a conta, a equipe e os convites, os canais (Zernio, UAZAPI e Instagram) e os produtos. |
| Contas | Fica só com o super-admin, que cria, renomeia, desativa e entra como suporte em cada organização. |

### A IA movendo o card

Depois de responder, a IA lê a conversa e move o card para a etapa cujo critério a conversa
cumpre com clareza. Ela só considera etapas com critério, precisa de 70% de confiança, espera
15 minutos entre dois movimentos do mesmo card e registra cada movimento no histórico do card,
com o motivo.

O funil "Vendas" da instalação já vem com critério em "Em conversa", "Recebeu oferta",
"Decidindo", "Fechou" e "Não fechou", e o funil novo criado na tela também nasce com critério.
O dono edita ou apaga cada critério na tela do funil. Para desligar o movimento inteiro, ele
desmarca "Mover as pessoas pelas etapas automaticamente" em Atendente IA, aba Agente.

### Organização nova

A organização criada em Contas já nasce com os funis "Vendas" e "Pós-venda", iguais aos da
instalação, e a primeira mensagem de um cliente para ela já vira card.

## Como a plataforma é montada

- **Telas:** são feitas em React 18, Vite 5, TypeScript e Tailwind 4 e ficam publicadas na
  Vercel.
- **Funções da Vercel (`api/`):** cuidam do assistente de instalação, do cofre de credenciais
  (cifrado com AES-256-GCM pela `CRYPTO_KEY`), da conexão com a Zernio e a UAZAPI e da
  administração das organizações.
- **Supabase:** guarda o banco Postgres (schema `whatsapp_hub`, com RLS por organização), o
  login, os arquivos e as Edge Functions em Deno (`supabase/functions/`). As Edge Functions
  recebem os webhooks, rodam a IA e enviam os disparos e o follow-up.
- **Integrações:** a Zernio conecta a API oficial do WhatsApp e o Instagram, e a UAZAPI conecta
  número não oficial. A OpenAI faz a busca na base de conhecimento, a transcrição de áudio e a
  leitura de imagem, e as respostas saem da OpenAI, do Claude ou do Gemini.

## Instalação

Você precisa de conta no GitHub, na Vercel e no Supabase, de uma conta na Zernio ou de uma
instância UAZAPI, e de uma chave da OpenAI.

1. Clique em **Use this template** e crie o repositório na sua conta.
2. Importe o repositório na Vercel e publique.
3. Abra a URL publicada e siga o assistente em `/setup`.

O assistente cria as tabelas, publica as funções, cria seu usuário e configura o ambiente em
cerca de dois minutos. O passo a passo completo, o caminho manual e a atualização de uma
instalação que já está no ar estão em [INSTALL.md](INSTALL.md).

## Desenvolvimento

O projeto usa Node 24. A CI compila com Node 20, e os testes que importam TypeScript direto
precisam do Node 24.

```bash
npm install
npm run dev
```

As variáveis de ambiente (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e
`CRYPTO_KEY`) estão explicadas em [INSTALL.md](INSTALL.md), seção 2.3. As chaves da Zernio, da
UAZAPI e da IA ficam no cofre de credenciais de cada organização e entram pelas telas.

### Banco e migrations

As migrations ficam em `supabase/migrations/` e rodam em ordem.

- `npm run db:status` mostra o que já foi aplicado e o que falta, sem escrever nada.
- `npm run db:push` aplica só o que falta. Ele reconhece o que o assistente de instalação já
  aplicou e para sem escrever nada quando o banco parece instalado sem registro de migrations.
- `npm run functions:deploy` publica as Edge Functions.

Toda migration nova precisa de um prefixo de data que nenhuma outra use e precisa terminar em
`;`, porque o assistente e o `db:push` gravam o registro logo depois do arquivo. Função
`SECURITY DEFINER` precisa de `REVOKE` explícito de `authenticated` e de `anon`, porque o
schema dá permissão de execução a usuário logado por padrão.

### Testes

| Comando | O que o comando confere |
|---|---|
| `npm run build` | os tipos das telas e das funções da Vercel, e o build do Vite |
| `npm run validate:sql` | o SQL de todas as migrations |
| `npm run test:migrations` | o `db:push` e o `db:status` |
| `npm run test:functions` | as regras do follow-up e dos fluxos |
| `npm run test:api` | as funções da Vercel, como a gravação do canal da Zernio |
| `npm run test:functions:e2e` | as Edge Functions de ponta a ponta, com um banco falso (precisa do Deno) |
| `node --test tests/sql/*.test.mjs` | as regras do banco num Postgres embutido (rode antes `npm i --no-save @electric-sql/pglite`) |

## Estrutura

```
src/                 telas em React
  app/               rotas, layout e provedores
  components/        componentes de cada área
  config/            marca (brand.ts) e nomes das telas (vocab.ts)
  hooks/ e lib/      leitura de dados e regras do navegador
api/                 funções da Vercel
supabase/
  migrations/        banco, aplicado em ordem
  functions/         Edge Functions em Deno
scripts/             db:push, db:status e publicação das funções
tests/               testes de scripts, funções, API, banco e especificações
public/              logo e rastreador de origem (ah-tracker.js)
```

## Sua marca

Edite `src/config/brand.ts` e troque `public/brand-mark.png` mantendo o nome do arquivo. As
cores ficam em `src/styles/globals.css`, e os nomes das telas ficam em `src/config/vocab.ts`.

## Documentos

- [INSTALL.md](INSTALL.md) traz a instalação completa, o caminho manual e a atualização de uma
  instalação que já está no ar.
- [CHANGELOG.md](CHANGELOG.md) registra as mudanças de cada versão.
- [CONTRIBUTING.md](CONTRIBUTING.md) explica como rodar e conferir o projeto antes de propor
  uma mudança.
- [AGENTS.md](AGENTS.md) e [CLAUDE.md](CLAUDE.md) dão contexto aos agentes de IA que editam o
  código, com as regras e as armadilhas conhecidas.

## Licença

O código usa a licença MIT, descrita em [LICENSE](LICENSE).
