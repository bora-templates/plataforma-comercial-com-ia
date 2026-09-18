# Guia de Instalação da Plataforma Comercial com IA

White-label self-hosted: **Plataforma Comercial com IA + CRM** (funil comercial, entrega de
projetos e educação) numa instância só, para uma organização.

> **O que é.** Plataforma de WhatsApp oficial (templates, campanhas, inbox com
> IA, RAG) **somada** à camada de CRM: o mesmo contato atravessa
> comercial → entrega → educação, com uma timeline e um inbox só.
>
> **Stack.** React 18 + Vite + Tailwind + shadcn · Supabase (Postgres, Auth,
> Realtime, Edge Functions, Storage, pgvector, pg_cron, pg_net) · WhatsApp via
> Zernio · Deploy Vercel.

---

## 0. Pré-requisitos

- **Node 20+** e **npm**
- Uma conta **Supabase** (1 projeto por instalação/cliente)
- Uma conta **Vercel** (deploy do frontend + API Routes)
- Uma **Zernio API Key** (conecta o WhatsApp; Embedded Signup no Zernio)
- Chave de **LLM** (OpenAI obrigatória p/ embeddings/Whisper; Claude/Gemini opcionais)

---

## 1. Caminho rápido (recomendado p/ cliente)

1. Clone o repositório:
   ```bash
   git clone <repo-do-cliente> meu-crm && cd meu-crm
   npm install
   ```
2. Importe o projeto na **Vercel** e faça o primeiro deploy.
3. Abra a URL publicada e siga o wizard em **`/setup`**.

O wizard `/setup` coleta as credenciais, **roda as migrations (cria todas as
tabelas)**, deploya as Edge Functions, grava as envs core na Vercel e salva as
credenciais de aplicação criptografadas no próprio Supabase. Ao terminar, a
instância já abre com **funil comercial e funil de entrega prontos** (seed).

---

## 2. Caminho manual / desenvolvimento

Use quando for desenvolver, ou instalar sem o wizard.

### 2.1. Banco de dados: criar as tabelas (o "SQL de instalação")

Toda a estrutura vive no schema **`whatsapp_hub`** e está versionada em
`supabase/migrations/`. A camada CRM é a migration
**`20260630120000_crm_layer.sql`** (funil, negócios, projetos, turmas,
matrículas, atividades, log de IA).

Aplique tudo com um comando, via a Management API (precisa só de um
**Personal Access Token** do Supabase, sem senha de banco):

```bash
# Gere um PAT em https://supabase.com/dashboard/account/tokens
export SUPABASE_ACCESS_TOKEN=sbp_xxx
export PROJECT_REF=<ref-do-projeto>           # ex.: iuuqpmesqvvbbdqdzthv
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # do dashboard do projeto
export APP_ENCRYPTION_KEY=<segredo-32-chars>          # qualquer string >= 16 chars

npm run db:push
```

O script `scripts/push-migrations.mjs` aplica cada migration em ordem, registra
o que já rodou (idempotente) e substitui os placeholders de segredo no momento
do push (nada sensível fica no git).

> Alternativa oficial: `supabase db push` (Supabase CLI), que requer a senha do
> banco. O `npm run db:push` evita isso usando o PAT.

### 2.2. Edge Functions

```bash
export SUPABASE_ACCESS_TOKEN=sbp_xxx
export PROJECT_REF=<ref>
npm run functions:deploy
```

### 2.3. Variáveis de ambiente (core)

Apenas **quatro** envs core existem em produção (preenchidas pelo wizard ou
manualmente na Vercel / `.env.local`):

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRYPTO_KEY=                # NÃO apague: decifra as credenciais em public.app_settings
```

As credenciais de aplicação (Zernio, OpenAI, Claude, Gemini) **não** ficam em
`.env`: são configuradas em `/settings/credentials` e guardadas criptografadas
em `public.app_settings`.

### 2.4. Rodar local

```bash
npm run dev          # http://localhost:5173
npm run validate:sql # valida todas as migrations (parse)
```

Para apontar o frontend a um Supabase real em dev, informe a URL + anon key no
wizard `/setup` (persistidas em localStorage) ou nas envs `VITE_`.

---

## 3. Primeiro acesso

- O owner nasce no wizard `/setup`, como **admin** da organização padrão. No
  caminho manual, o **primeiro usuário** criado vira o owner (trigger
  `handle_new_user`).
- Depois do owner, **ninguém entra por cadastro**. A equipe entra por convite
  na tela Equipe (link copiável ou e-mail), e o banco recusa qualquer usuário
  novo que não tenha convite registrado pelo backend.
- O wizard desliga o cadastro aberto do Supabase Auth. No caminho manual,
  desligue à mão depois de criar o owner: painel do Supabase, **Authentication →
  Sign In / Providers → Allow new users to sign up** desligado. Convite por
  link e por e-mail continuam funcionando com essa chave desligada.
- Admin controla templates, campanhas, knowledge, equipe e configurações.
- Operator opera inbox, contatos, funil e entrega no dia a dia.

---

## 4. White-label / branding

Personalize por cliente sem tocar na lógica:

| O quê | Onde |
|---|---|
| Nome da ferramenta + credenciais do wizard | `setup.config.ts` (`toolName`, `appCredentials`) |
| Tokens de cor / tema (dark glassmorphism) | `src/styles/globals.css` (variáveis `--accent-primary`, etc.) |
| Logo e ajustes visuais | `src/customizations/` |
| Buckets de storage | prefixo `whatsapp-hub-*` |

> O schema permanece `whatsapp_hub` (não renomear: o código todo referencia
> `.schema('whatsapp_hub')`). É o schema único do produto, agora incluindo a
> camada CRM.

---

## 5. Verificação pós-instalação

1. `/setup` concluído sem erros.
2. Login criando o admin.
3. **Funil comercial** abre com as etapas-padrão (Novo lead → … → Ganho/Perdido).
4. **Inbox** conecta no Zernio e recebe mensagens em tempo real.
5. Um contato aparece igual em Contatos, Inbox e Funil (mesma pessoa, uma timeline).

---

## 6. O que a camada CRM adiciona (resumo do schema)

`supabase/migrations/20260630120000_crm_layer.sql` cria, no schema
`whatsapp_hub`, ancorado em `contacts`:

- `pipelines` + `stages`: funis customizáveis (comercial / projeto / turma)
- `deals`: negócios (funil comercial)
- `projects` + `project_tasks`: entrega
- `courses` + `classes` + `enrollments`: educação
- `crm_activities`: tarefas / notas / follow-ups do funil
- `crm_ai_actions`: log auditável das ações da IA
- RPC `crm_promote_deal_to_project(deal_id)`: promove negócio ganho a projeto

RLS no padrão do hub: leitura para qualquer autenticado; escrita para
`admin`/`operator`.

---

## 7. Atualização de segurança de 18/09/2026: convite só pelo backend

Vale para toda instalação criada antes de 18/09/2026. Até esta correção, o banco
aceitava como convite qualquer cadastro que declarasse, no próprio cadastro, o
papel e a organização. Com o cadastro aberto do Supabase Auth ligado, quem
soubesse o id da organização conseguia criar uma conta de admin nela. O risco é
real para quem configurou SMTP próprio ou desligou a confirmação de e-mail; no
Supabase com o e-mail padrão e a confirmação ligada, o próprio serviço recusa o
cadastro de quem não é membro do projeto.

**1. Agora, sem mexer em código (30 segundos).** No painel do Supabase do seu
projeto: **Authentication → Sign In / Providers → Allow new users to sign up**
desligado, e salve. Isso fecha a porta sozinho. Convite por link e por e-mail,
login e troca de senha continuam funcionando.

**2. Confira se alguém entrou sem convite.** No **SQL Editor** do Supabase:

```sql
select u.email, u.created_at, au.role, o.name as organizacao
  from auth.users u
  join whatsapp_hub.app_users au on au.user_id = u.id
  left join whatsapp_hub.organizations o on o.id = au.org_id
 where u.raw_user_meta_data ? 'invited_role'
   and u.invited_at is null
   and au.is_super_admin = false
 order by u.created_at;
```

Convite feito pela tela Equipe grava `invited_at`. Linha que aparecer aqui
merece conferência: se você reconhece o e-mail como alguém que você convidou,
está tudo certo. Se não reconhece, remova a pessoa na tela Equipe e troque as
credenciais de integração (WhatsApp e LLM) em Credenciais.

**3. Atualize o código, nesta ordem.**

1. Traga do template os quatro arquivos da correção:
   `supabase/migrations/20260918120000_convite_so_pelo_backend.sql`,
   `supabase/functions/invite-team-member/index.ts`, `api/bootstrap.ts` e
   `api/admin/orgs.ts`.
2. Publique as Edge Functions (`npm run functions:deploy`, seção 2.2). A função
   nova funciona com o banco antigo e com o novo.
3. Aplique a migration. Quem instalou pelo wizard `/setup` cola o conteúdo do
   arquivo `.sql` no **SQL Editor** e executa (ela é idempotente, pode rodar
   mais de uma vez). Quem instalou pelo caminho manual roda `npm run db:push`.
4. `git push`, para a Vercel publicar as rotas `api/`.

Depois do passo 3, convide alguém na tela Equipe para confirmar que o link sai.
Se aparecer "O banco recusou a criação do convite", a função do passo 2 ainda
não foi publicada.

Para conferir a regra num banco descartável, sem tocar no seu projeto:

```bash
npm i --no-save @electric-sql/pglite
node tests/sql/convite-so-pelo-backend.test.mjs
```
