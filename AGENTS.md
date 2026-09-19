# AGENTS.md: Plataforma Comercial com IA

## Visão geral

Plataforma self-hosted de automação WhatsApp. Uma instância
atende **uma única organização**: criação de templates assistida por IA,
aprovação na Meta, disparos em massa por tier, agente de IA com RAG, inbox em
tempo real com handoff IA ↔ humano, dashboard analítico.

> Para o passo a passo de instalação pelo wizard `/setup`, consultar `README.md`. O `AGENTS.md` foca
> em *como o código está organizado* e nas regras a respeitar ao alterá-lo.

---

## Stack

- **Frontend.** React 18 + Vite + TypeScript + Tailwind CSS v4 + shadcn/ui.
- **Backend.** Supabase Cloud (Postgres, Auth, Realtime, Edge Functions,
  Storage, pgvector).
- **Jobs & Cron.** `pg_cron` + `pg_net` para disparos em batch, follow-ups e
  polling de status de templates.
- **API WhatsApp.** Meta Cloud API oficial (v21+).
- **Embeddings.** OpenAI `text-embedding-3-small` (sempre, independente da
  LLM escolhida).
- **LLMs disponíveis.** OpenAI · Anthropic Codex · Google Gemini. A escolha
  fica na credencial `llm_provider` em `public.app_settings` (definida no
  wizard `/setup` ou em `/settings/credentials`) e é lida em runtime via
  `getCredential`. Não existe env var `LLM_PROVIDER`.
- **Transcrição de áudio.** OpenAI Whisper.
- **Idioma da interface.** Português BR (sem i18n no v1).

---

## Self-Hosted Setup

A instalação de produção é orientada pelo wizard `/setup`. Ele coleta os
tokens de bootstrap, roda migrations, deploya Edge Functions, configura as
envs core na Vercel e persiste credenciais de aplicação criptografadas em
`public.app_settings`.

---

## Arquitetura multi-schema (Supabase compartilhado)

O mesmo Supabase pode hospedar várias apps. Cada app vive em seu
próprio schema PostgreSQL.

### Schemas ativos

- `public`: reservado para extensions e tipos compartilhados (NÃO usar para
  dados de aplicação).
- `outro_app`
- `prospector`
- `crm_sofia`
- `whatsapp_hub`: **este projeto**.

### Regras de schema

1. Toda tabela de aplicação fica em `whatsapp_hub.*`.
2. Migrations começam com:
   ```sql
   CREATE SCHEMA IF NOT EXISTS whatsapp_hub;
   SET search_path TO whatsapp_hub;
   ```
3. Cada schema tem seu próprio conjunto de policies RLS.
4. Nunca fazer cross-schema joins sem aprovação explícita.
5. Storage buckets prefixados: `whatsapp-hub-*`.
6. PostgREST precisa expor o schema (ver `README.md` passo 4).

### Padrão de queries no frontend

```ts
const { data } = await supabase
  .schema('whatsapp_hub')
  .from('conversations')
  .select('*');
```

Nunca usar o schema `public` para lógica de aplicação.

---

## Auth & Roles

- Supabase Auth com email/senha.
- Enum `whatsapp_hub.tenant_role` (nome herdado, semântica nova): valores
  permitidos `'admin' | 'operator'`.
- Trigger `whatsapp_hub.handle_new_user` em `auth.users` (versão vigente na
  migration `20260918120000_convite_so_pelo_backend.sql`):
  - Se `app_users` está vazia, o novo usuário é o owner: `admin` + super admin
    da organização padrão.
  - Senão, só entra quem tem **convite registrado pelo backend**: o trigger
    procura em `whatsapp_hub.pending_invites` um registro válido para o mesmo
    e-mail, com o hash do `raw_user_meta_data.invite_token`. Papel e
    organização saem do registro. `invited_role` e `invited_org_id` do metadata
    **não são lidos**, porque o metadata é escrito pelo cliente no cadastro.
  - Qualquer outro cadastro é recusado com exceção (o insert é desfeito).
  - Insere em `app_users (user_id, org_id, role, accepted_at)`; convite nasce
    com `accepted_at` nulo (pendente) e o trigger `on_auth_user_accepted` marca
    o aceite no primeiro login ou na confirmação do e-mail.
  - Espelha `role`, `org_id`, `home_org_id` e `is_super_admin` em
    `auth.users.raw_app_meta_data` para que policies consultem via JWT sem ler
    `app_users`.
- **Regra de segurança:** nada que o cliente escreve (`raw_user_meta_data`,
  corpo de requisição, query string) decide papel ou organização. Quem decide é
  registro gravado com service role depois de `requireAdmin`. O id da
  organização aparece em URL pública de Storage e não é segredo.
- O cadastro aberto do Supabase Auth fica **desligado** (`disable_signup`): o
  wizard `/setup` desliga no bootstrap. Owner (admin API), `inviteUserByEmail` e
  `generateLink` não dependem dessa chave e seguem funcionando.
- `app_users` é a tabela de membros da instância (substitui `tenant_members`
  do build SaaS antigo). UNIQUE por `user_id`.
- Policies RLS gateiam por `whatsapp_hub.current_user_role()`:
  - `'admin'`: controla templates, campanhas, knowledge, settings, equipe.
  - `'operator'`: opera inbox + contatos + tags do dia a dia.

---

## Banco de dados (schema `whatsapp_hub`)

### Tabelas centrais

```
app_settings (singleton, id = 1)
├── business_hours        JSONB   ({ mon: {start,end}, tue: ..., ... })
├── out_of_hours_message  TEXT
└── onboarding_completed  BOOLEAN  (mantido como flag de "settings preenchidos")

app_users
├── user_id  UUID  (FK auth.users, UNIQUE)
├── role     ENUM('admin','operator')
├── is_online  BOOLEAN
├── last_seen_at, accepted_at, created_at, invited_at

ai_agent_config  (singleton via UNIQUE INDEX em ((true)))
├── system_prompt TEXT
├── temperature   FLOAT DEFAULT 0.7
├── max_tokens    INT   DEFAULT 1000
├── is_active     BOOLEAN DEFAULT true

contacts
├── id, phone (E.164, UNIQUE), name, email
├── custom_fields JSONB

tags
├── id, name (UNIQUE), color

contact_tags  (N:N contact_id × tag_id)

templates
├── id, name (UNIQUE), category ENUM('marketing','utility','service')
├── language DEFAULT 'pt_BR'
├── status ENUM('draft','pending','approved','rejected')
├── meta_template_id, meta_template_status
├── header_type, header_content
├── body, footer
├── buttons   JSONB
├── variables JSONB  (posição → descrição)
├── ai_prompt TEXT   (prompt original do usuário, quando gerado por IA)

campaigns
├── id, name, template_id
├── status ENUM('draft','scheduled','sending','completed','paused','failed')
├── scheduled_at      TIMESTAMPTZ NULL
├── audience_filter   JSONB (tags + custom_fields filters)
├── variable_mapping  JSONB (variável → contact field / CSV column)
├── total_contacts, sent, delivered, read, replied, failed  INT

campaign_contacts  (fila de disparo + métricas por contato)
├── id, campaign_id, contact_id
├── status ENUM('pending','sent','delivered','read','replied','failed')
├── error_message
├── sent_at, delivered_at, read_at, replied_at
├── meta_message_id
├── template_id_override   (per-row, usado por follow-ups)

follow_up_rules
├── trigger_condition ENUM('no_reply')
├── delay_hours INT
├── template_id   (template do follow-up)
├── sequence_order INT
├── is_active BOOLEAN

conversations
├── id, contact_id (UNIQUE)
├── status ENUM('ai_active','human_active','closed')
├── assigned_to UUID, assigned_at
├── ai_paused BOOLEAN DEFAULT false
├── last_message_at, unread_count

messages
├── id, conversation_id
├── direction ENUM('inbound','outbound')
├── sender_type ENUM('contact','ai','operator','system')
├── sender_id UUID (operador, opcional)
├── content_type ENUM('text','image','audio','video','document','template','note')
├── content TEXT, media_url TEXT
├── meta_message_id, meta_status ENUM('sent','delivered','read','failed')
├── is_private_note BOOLEAN DEFAULT false

knowledge_base
├── id, name, type ENUM('pdf','doc','url')
├── source_url, file_path, file_size_bytes
├── status ENUM('processing','ready','error')

knowledge_chunks
├── id, knowledge_base_id
├── content TEXT, embedding VECTOR(1536)
├── metadata JSONB

notifications
├── id, user_id, type ENUM('new_message','handoff','mention')
├── conversation_id, message_id
├── title, body, is_read
```

### Extensions (schema `public`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- RAG
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- helpers gerais
CREATE EXTENSION IF NOT EXISTS pg_cron;    -- jobs agendados
CREATE EXTENSION IF NOT EXISTS pg_net;     -- HTTP a partir do Postgres
```

### RLS

- Toda tabela de domínio tem RLS habilitado.
- Padrão: `SELECT` aberto a `authenticated`; `INSERT/UPDATE/DELETE` gated por
  `whatsapp_hub.current_user_role()`. Templates / campanhas / knowledge são
  admin-only para escrita; contatos / conversas / mensagens permitem
  operadores + admin.
- `app_settings` e `ai_agent_config` são singletons com escrita admin-only.
- `notifications` filtrada por `user_id = auth.uid()`.

### RPCs notáveis

- `whatsapp_hub.knowledge_search(p_query_embedding vector, p_top_k int)` -
  similarity search (cosine) no corpus, retornando `(id, knowledge_base_id,
  content, similarity)`.
- `whatsapp_hub.current_user_role()`: usado nas policies RLS.

### Credenciais e bootstrap (schema `public`)

Diferente das tabelas de domínio (que vivem em `whatsapp_hub`), o cofre de
credenciais e o estado de bootstrap ficam em `public` por serem infra de
instância, não dados de aplicação. Criadas pela migration
`20260521180500_setup_infra.sql`:

```
public.app_settings              <- SINGLE SOURCE OF TRUTH das credenciais
├── key             text PK       (ex.: meta_access_token, llm_provider, ...)
├── value_encrypted text          (AES-256-GCM, formato "iv:tag:cipher")
└── updated_at      timestamptz

public._bootstrap_state           <- checkpoints idempotentes do wizard /setup
├── step         text PK          (connection_ok, migrations_done, owner_created, migration:<arquivo.sql>, ...)
├── completed_at timestamptz
└── metadata     jsonb            (nunca guarda senha; só user_id/email/count)
```

- **Não confundir** com `whatsapp_hub.app_settings` (o singleton de
  `business_hours` / `out_of_hours_message`). São tabelas distintas, em schemas
  distintos, com propósitos distintos.
- Ambas têm RLS habilitado **sem nenhuma policy** → inacessíveis a `anon` e
  `authenticated`. Só a service role (API Routes Vercel + Edge Functions) lê e
  escreve. O frontend nunca consulta `app_settings` diretamente.
- **Leitura: `getCredential(key)` é o único acessador**, sobre `app_settings`:
  - Node (API Routes): `src/lib/credentials.ts`
    (`encrypt`/`decrypt`/`getCredential`/`setCredential`).
  - Deno (Edge Functions): `_shared/credentials.ts` (decrypt-only + cache 60s).
  - `_shared/tenant-credentials.ts::loadAppCredentials()` é apenas um **wrapper
    tipado** sobre `getCredential`; não é fonte de verdade e não lê env vars.
- **Escrita** só via `api/credentials.ts` (`setCredential`), que valida cada
  valor server-side e exige sessão de owner/admin.
- `CRYPTO_KEY` (env core) decifra os valores; sem ela os dados em
  `app_settings` são irrecuperáveis.

### Migrations: dois controles, uma regra

- O wizard `/setup` (`api/bootstrap.ts`) grava um step `migration:<arquivo.sql>`
  em `public._bootstrap_state`. O `npm run db:push`
  (`scripts/push-migrations.mjs`) grava a `version` (prefixo numérico do arquivo)
  em `supabase_migrations.schema_migrations`, o formato do Supabase CLI.
- Desde 18/09/2026 os dois gravam nos dois lugares, e o `db:push` considera
  aplicada a migration que estiver em qualquer um deles. A cada execução ele
  também copia para o outro lado o registro que faltar. Antes disso, rodar
  `db:push` numa instalação feita pelo wizard reaplicava tudo desde a primeira
  migration, inclusive as destrutivas.
- Caminho de atualização de uma instalação no ar: `npm run db:status` (só lê) e
  depois `npm run db:push`. Sem terminal, SQL Editor. Passo a passo no
  `INSTALL.md`, seção 8. Clone sem o script `db:status` ainda tem o `db:push`
  antigo e não pode rodá-lo em instalação de wizard.
- Trava: se o schema `whatsapp_hub` existe e a primeira migration não tem registro
  em nenhum dos dois controles, o `db:push` sai com código 3 sem executar nada.
- Migration nova precisa ser idempotente, terminar em `;` (o wizard e o `db:push`
  colam o SQL de registro logo depois do arquivo, na mesma chamada) e usar
  prefixo numérico inédito. O par `20260811120000_*` é histórico e não pode ser
  renomeado, porque o nome do arquivo é a identidade gravada pelo wizard.
- A lógica vive em `scripts/lib/migration-plan.mjs` (`planMigrations` é função
  pura). `api/bootstrap.ts` repete a regra de identidade do arquivo de propósito:
  a função da Vercel não importa nada de `scripts/`.
- Testes sem banco real: `npm run test:migrations`. Com
  `npm i --no-save @electric-sql/pglite` instalado, os mesmos cenários rodam num
  Postgres embutido. Nunca testar `db:push` contra projeto Supabase em produção.

---

## pg_cron jobs

| Job                     | Cadência     | Função                  |
|-------------------------|--------------|-------------------------|
| `dispatch-campaigns`    | 30 segundos  | `dispatch-campaign`     |
| `check-follow-ups`      | a cada 15min | `check-follow-ups`      |
| `check-template-status` | a cada 5min  | `check-template-status` |

Os jobs invocam Edge Functions via `pg_net.http_post`. URL do projeto e
service role key vêm de Vault entries (`whatsapp_hub_supabase_url`,
`whatsapp_hub_service_role_key`) seedadas pelo `npm run db:push`.

---

## Funcionalidades

### Templates com IA

1. Operador escolhe categoria (Marketing / Utility / Service), descreve o
   objetivo, marca variáveis e tipo de header.
2. Frontend chama `generate-template`. A função lê o provider de
   `app_settings` (`getCredential('llm_provider')`), monta o prompt e devolve
   o template estruturado.
3. Operador revisa, edita se quiser, e submete. `submit-template` envia para
   `POST /v21.0/{waba_id}/message_templates`.
4. `check-template-status` (cron 5min) faz polling até `approved` ou
   `rejected`.

### Disparos em massa

1. Selecionar template aprovado.
2. Audiência: tags + filtros custom + upload CSV/XLSX (E.164 + dedup).
3. Mapear variáveis → campos do contato / colunas do CSV.
4. Agendar ou disparar imediatamente.
5. `dispatch-campaign` (cron 30s) lê batch de `campaign_contacts.pending`
   limitado pelo `META_TIER`, envia via Meta, atualiza status individual,
   tolera 429 com backoff.
6. `meta-webhook` ingere statuses (sent / delivered / read / failed) e
   incrementa contadores agregados na campanha.

### Follow-up rules

Motor: `check-follow-ups` (cron 15min). A decisão de cada trava mora no módulo
puro `_shared/follow-up-rules.ts`; o `index.ts` só consulta e envia.

- Três gatilhos: `no_reply` (reengajamento de campanha, enfileira em
  `campaign_contacts` com `template_id_override`), `inactivity` (conversa de
  WhatsApp parada há `delay_hours`, envio 1:1) e `no_purchase` (cliente sem
  compra há `params.days`, envio 1:1). Dedup do 1:1 em `follow_up_log`: uma vez
  por regra × contato.
- Regras rodam por conta e por `sequence_order` (toque 1 antes do toque 3). Cada
  envio zera `conversations.last_message_at`, então só o primeiro toque que casa
  sai na rodada.
- **Horário de atendimento.** Conta fora do horário (`app_settings.business_hours`
  no fuso de `ai_agent_config.timezone`) não envia nem enfileira, e nada vai para
  o `follow_up_log`. A rodada seguinte dentro do horário envia. Conta que nunca
  salvou o horário (`{}`) continua enviando a qualquer hora, e a tela avisa.
- **Janela de inatividade.** A regra só olha conversa cuja última mensagem veio
  depois de ela ser ligada (o maior entre `created_at` e `updated_at`, que muda
  ao religar) e há no máximo `delay_hours` + 7 dias (`MAX_EXTRA_IDLE_HOURS`).
  Primeira ativação e regra religada nunca alcançam o histórico.
- **Quem falou por último.** `inactivity` só dispara quando a última mensagem não
  privada é `outbound`. Lead esperando resposta e conversa sem mensagem ficam de
  fora. Conversa com o time (`human_active` ou `ai_paused`) fica de fora, a menos
  que a regra grave `params.include_human_active = true` (caixa "Incluir
  conversas que estão com uma pessoa do time" no formulário). Conta que atende só
  com pessoas precisa dessa caixa: com o agente desligado, o `process-ai-message`
  deixa toda conversa em `human_active`.
- **Variáveis.** `{{1}}` recebe o primeiro nome (`firstNameOf`), ou
  `params.name_fallback`; `params.template_params` fixa valores por posição e
  aceita `{nome}`. Parâmetro vazio nunca sai: template com `{{2}}` em diante sem
  valor fixo derruba a regra com um erro só, e a tela barra ao salvar.
  `message_text` (UAZAPI) aceita `{nome}`. A ação `send_template` /
  `send_text` de `funnel-automation` segue a mesma regra (`action.params`,
  `action.name_fallback`).
- **Filtro de tag.** `params.tag_id` casa com `contact_tags` (tag da pessoa) OU
  `deal_tags` (tag da oportunidade, onde a ação `add_tag` dos fluxos grava).
- Leitura que falha (log, filtros, horário) derruba a regra naquela rodada em vez
  de virar envio repetido. Listas de ids em `.in()` vão em fatias de 100.
- Resposta do contato cancela os follow-ups de campanha (`no_reply`) futuros.

Testes: `npm run test:functions` (módulo puro, Node) e
`npm run test:functions:e2e` (handler de verdade no Deno contra PostgREST, Zernio
e UAZAPI de mentira em `tests/functions/lib`, mais o bundle montado pelo wizard).
Coluna nova em migration precisa entrar no `SCHEMA` de
`tests/functions/lib/fake-backend.ts`, que recusa coluna desconhecida como o
PostgREST de verdade.

### Agente IA + RAG

- Knowledge base aceita PDFs, docs e URLs (até 30MB no total).
- `process-knowledge`: extract → chunk (500 tokens, overlap 50) → embed
  (`text-embedding-3-small`, 1536d) → store em `knowledge_chunks`.
- Mensagem inbound aciona `process-ai-message`:
  1. Busca top-5 chunks via `knowledge_search`.
  2. Monta prompt com `system_prompt` (do `ai_agent_config`) + contexto +
     histórico da conversa.
  3. Chama o provider configurado na credencial `llm_provider`.
  4. Envia resposta via Meta API.
- Handoff: operador clica "Pausar IA" → `conversation.ai_paused = true` →
  trigger `_on_handoff_notify` faz fanout para todos operadores.
- Áudio do contato → `transcribe-audio` (Whisper) → salva como `content` da
  mensagem, mantendo `media_url` original.

### Inbox

- Layout 3 painéis (lista de conversas, thread, dados do contato).
- Realtime via Supabase Realtime nos canais de `messages` e `conversations`.
- Notas privadas (`is_private_note = true`): fundo diferenciado, não
  enviadas ao contato.
- Atribuição automática round-robin entre operadores com `is_online = true`.
- Filtros: status, assigned_to, tags, período.

### Dashboard

- Cards de métricas (mensagens enviadas / entregues / lidas / respondidas,
  com trend %).
- Métricas secundárias: custo por conversa (pricing Meta por categoria + país),
  tempo médio de resposta da IA, tempo médio do humano, distribuição de
  status das conversas.
- Gráficos Recharts: line (volume / dia), bar (taxas por campanha), donut
  (status).

---

## Estrutura de pastas (frontend)

```
src/
├── app/
│   ├── routes/
│   │   ├── setup/            Bootstrap Supabase (URL + anon key → localStorage)
│   │   ├── auth/             Login, signup
│   │   ├── dashboard/
│   │   ├── inbox/
│   │   ├── campaigns/
│   │   ├── templates/
│   │   ├── contacts/
│   │   ├── knowledge/
│   │   ├── follow-ups/
│   │   └── settings/
│   │       ├── SettingsPage.tsx
│   │       └── sections/
│   │           ├── AccountSettings.tsx
│   │           ├── AIAgentSettings.tsx
│   │           ├── BusinessHoursSettings.tsx
│   │           ├── SupabaseSettings.tsx
│   │           └── TeamSettings.tsx
│   ├── layout/               AppLayout, Sidebar, Header
│   ├── router.tsx            RequireSetup → RequireSession → AppLayout
│   └── providers/
│       ├── SupabaseProvider.tsx
│       ├── AuthProvider.tsx
│       └── AppUserProvider.tsx   (consome app_users, expõe role)
├── components/
│   ├── ui/                   primitives shadcn
│   ├── inbox/                ChatBubble, ConversationList, NoteInput, …
│   ├── campaigns/            CampaignWizard, VariableMapper, AudienceSelector
│   ├── templates/            TemplateEditor, TemplatePreview, AIGenerator
│   ├── contacts/             ContactTable, CSVUploader, TagManager
│   └── NotificationsDropdown.tsx
├── hooks/                    useCampaigns, useConversations, useTemplates,
│                             useContacts, useKnowledgeBase, useDashboardMetrics,
│                             useFollowUpRules, useMessages, useNotifications,
│                             useTags, useSupabase
├── lib/                      supabase.ts (dynamic client), phone.ts (E.164)
├── types/                    db, inbox, campaigns, templates, knowledge
└── styles/globals.css        Tailwind v4 + dark glassmorphism tokens
```

## Edge Functions

```
supabase/functions/
├── _shared/
│   ├── auth.ts               requireCaller, requireAdmin (JWT validation)
│   ├── cors.ts               jsonResponse, preflight
│   ├── llm.ts                multi-provider adapter (OpenAI/Codex/Gemini)
│   ├── supabase-admin.ts     service role client
│   ├── credentials.ts        getCredential() sobre public.app_settings (SSOT)
│   ├── tenant-credentials.ts loadAppCredentials() → wrapper tipado de getCredential
│   └── follow-up-rules.ts    regras PURAS do follow-up (horário, ordem, janela, quem falou por último, variáveis)
├── meta-webhook/             ingestão (HMAC-SHA256) de statuses + inbound
├── dispatch-campaign/        consumido por pg_cron 30s
├── check-follow-ups/         consumido por pg_cron 15min
├── check-template-status/    consumido por pg_cron 5min
├── process-ai-message/       RAG → LLM → resposta via Meta
├── process-knowledge/        upload → chunk → embed → store
├── transcribe-audio/         baixa áudio Meta → Whisper
├── generate-template/        prompt → LLM → JSON estruturado de template
├── submit-template/          POST p/ Meta `message_templates`
├── send-operator-message/    operador envia texto/mídia pela inbox
├── simulate-inbound/         dev only: finge mensagem inbound
├── test-meta-connection/     valida credenciais Meta
└── invite-team-member/       cria convite (link copiável + e-mail, role)
```

---

## Convenções de código

### Geral
- TypeScript strict mode.
- ESLint + Prettier.
- Componentes: PascalCase. Hooks: `useThing.ts`. Edge Functions: kebab-case.
- Comentários: português para regra de negócio; inglês para código técnico.

### Supabase / frontend
- Client criado via `getSupabase()` a partir das envs core injetadas no build
  apos o wizard `/setup`.
- **Sempre** usar `.schema('whatsapp_hub')` no client.
- Tipos manuais em `src/types/`. Não usamos `supabase gen types` no v1.

### Edge Functions
- Toda função pública passa pelos helpers `_shared/auth.ts`. Nunca pular essa
  validação.
- Credenciais de aplicação têm como **fonte de verdade** `public.app_settings`
  e são lidas via `getCredential` (`_shared/credentials.ts`).
  `_shared/tenant-credentials.ts::loadAppCredentials()` é só um wrapper tipado
  sobre ele e nunca lê env vars de aplicação. `Deno.env.get(...)` fica restrito
  a envs core (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRYPTO_KEY`).
- Resposta padrão: `{ data, error, message }` via `jsonResponse`.
- Logging estruturado: `console.log(JSON.stringify({ event, ... }))`.
- O wizard `/setup` não sobe a pasta `_shared/`: `bundleEdgeFunction`
  (`api/bootstrap.ts`) cola cada `_shared` importado no MESMO escopo do
  `index.ts`. Nome de topo repetido entre o `index.ts` e um `_shared` (ou entre
  dois `_shared`) vira "Identifier has already been declared", e a função morre
  com BOOT_ERROR só na instalação pelo wizard. O `functions:deploy` da CLI
  preserva o escopo de cada módulo, por isso o problema passa despercebido em
  quem publica pelo terminal. Código compartilhado entre funções mora em
  `_shared/`, porque import de arquivo vizinho (`./algo.ts`) fica fora do bundle.
  `tests/scripts/edge-bundle.test.mjs` monta o bundle de todas as funções e
  confere a sintaxe (`npm run test:migrations`).

### Segurança
- HMAC-SHA256 (timing-safe) na validação do webhook Meta.
- Tokens / API keys nunca trafegam pelo frontend: todas as chamadas a
  Meta / OpenAI / Codex / Gemini saem das Edge Functions.

---

## Design System: Dark Mode Glassmorphism (OBRIGATÓRIO)

A plataforma é **dark mode only**. Não implementar light mode. Não criar
toggle de tema.

### Tokens de cor

| Token                  | Valor                                        |
|------------------------|----------------------------------------------|
| `--bg-primary`         | `#0A0A0F`                                    |
| `--bg-card`            | `rgba(15, 18, 35, 0.6)`                      |
| `--border-card`        | `rgba(59, 130, 246, 0.15)`                   |
| `--accent-primary`     | `#3B82F6`                                    |
| `--accent-secondary`   | `#60A5FA`                                    |
| `--gradient-primary`   | `linear-gradient(135deg, #1E3A8A, #3B82F6)`  |
| `--text-primary`       | `#F8FAFC`                                    |
| `--text-secondary`     | `#94A3B8`                                    |
| `--text-label`         | `#CBD5E1`                                    |
| `--color-success`      | `#10B981`                                    |
| `--color-error`        | `#EF4444`                                    |

### Background glow (no `body`)

```css
body {
  background-color: #0A0A0F;
  background-image:
    radial-gradient(ellipse at 20% 0%, rgba(59, 130, 246, 0.06), transparent 50%),
    radial-gradient(ellipse at 80% 100%, rgba(37, 99, 235, 0.04), transparent 50%);
  min-height: 100vh;
}
```

### Glass card padrão

```css
.glass-card {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.02));
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 16px;
  box-shadow:
    0 0 20px rgba(59, 130, 246, 0.06),
    inset 0 1px 0 rgba(59, 130, 246, 0.1);
}

.glass-card:hover {
  border-color: rgba(59, 130, 246, 0.45);
  box-shadow:
    0 0 30px rgba(59, 130, 246, 0.12),
    0 0 60px rgba(59, 130, 246, 0.04),
    inset 0 1px 0 rgba(59, 130, 246, 0.2);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Tipografia

```css
* { font-family: 'Inter', sans-serif; }

.text-display { font-weight: 700; }
.text-stat    { font-size: 2.5rem; font-weight: 800; }

.text-label {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.text-body { font-weight: 400; font-size: 0.875rem; }
```

### Bordas e separadores

- Borders padrão: `rgba(59, 130, 246, 0.12)`.
- Dividers: `rgba(59, 130, 246, 0.08)`.
- Sidebar `border-right`: `1px solid rgba(59, 130, 246, 0.1)`.
- Header `border-bottom`: `1px solid rgba(59, 130, 246, 0.08)`.

Componentes devem usar `var(--accent-primary)` / `var(--accent-secondary)` em
vez de hardcodear `#3B82F6` / `#60A5FA`. Os hex listados acima são apenas o
fallback default.

---

## Notas de migração e variáveis não-triviais

- A tabela de membros chama-se `app_users`.
  → OSS. O enum `whatsapp_hub.tenant_role` manteve o nome por inércia, mas
  hoje só aceita `'admin' | 'operator'`.
- A fonte de verdade das credenciais de aplicação é `public.app_settings`
  (KV criptografado), acessada por `getCredential`/`setCredential`.
  `_shared/tenant-credentials.ts` mantém o nome histórico, mas hoje é só um
  wrapper tipado sobre `getCredential`; não lê env vars nem é fonte própria.
- `campaign_contacts.template_id_override` é per-row e existe para que o
  dispatcher use um template diferente do template-pai da campanha em
  follow-ups.
- O convite é autorizado por `whatsapp_hub.pending_invites`, gravada só pela
  RPC `register_pending_invite` (EXECUTE apenas para `service_role`; o schema dá
  EXECUTE a `authenticated` por default privilege, então toda função sensível
  nova precisa de `REVOKE` explícito). A RPC devolve um token de uso único que
  viaja em `raw_user_meta_data.invite_token`; o banco guarda só o sha256 e o
  registro vence em 15 minutos, porque o usuário é criado na mesma requisição.
  `invited_role` / `invited_org_id` continuam indo no metadata apenas para
  instalação que ainda não aplicou a migration `20260918120000`. Teste de
  regressão: `tests/sql/convite-so-pelo-backend.test.mjs` (Postgres embutido).
- A Vault entry `whatsapp_hub_encryption_key` ainda existe por motivos
  históricos (a migração `20260422120012` a cria), mas nenhum código atual
  consome `encrypt_secret`/`decrypt_secret`.
