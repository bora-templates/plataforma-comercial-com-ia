// ============================================================================
// Backend de mentira para testar Edge Function de ponta a ponta, sem rede.
// ----------------------------------------------------------------------------
// Troca o fetch global por um roteador em memória que responde como:
//   · PostgREST do Supabase  (SUPABASE_URL/rest/v1/<tabela> e /rpc/<função>)
//   · Zernio                 (https://zernio.com/api/v1/...)
//   · UAZAPI                 (uazapi_server_url do canal)
// O handler de verdade da função roda inteiro: supabase-js monta a URL, este
// arquivo interpreta os filtros e devolve as linhas. Nada aqui é mock de função.
//
// O PostgREST de mentira é rígido de propósito: tabela ou coluna que não existe
// nas migrations responde erro, como o de verdade. As colunas de SCHEMA foram
// tiradas de supabase/migrations (mais org_id, que o loop multi-org adiciona).
// Ao criar coluna nova numa migration, acrescente aqui também.
// ============================================================================

export type Row = Record<string, unknown>;

interface TableDef {
  columns: string[];
  unique?: string[][];
  // coluna FK → tabela referenciada (para o embed `alias:coluna(campos)`)
  fks?: Record<string, string>;
}

const HUB = 'whatsapp_hub';

export const SCHEMA: Record<string, TableDef> = {
  [`${HUB}.organizations`]: { columns: ['id', 'name', 'slug', 'status', 'created_at', 'updated_at'] },
  [`${HUB}.follow_up_rules`]: {
    columns: ['id', 'org_id', 'campaign_id', 'trigger_condition', 'delay_hours', 'template_id', 'sequence_order',
      'is_active', 'created_at', 'updated_at', 'provider', 'message_text', 'params'],
  },
  [`${HUB}.follow_up_log`]: {
    columns: ['org_id', 'rule_id', 'contact_id', 'sent_at'],
    unique: [['rule_id', 'contact_id']],
  },
  [`${HUB}.contacts`]: {
    columns: ['id', 'org_id', 'phone', 'name', 'email', 'custom_fields', 'created_at', 'updated_at', 'source',
      'instagram_id', 'first_seen_at', 'kind', 'profile_pic_url', 'profile_pic_updated_at'],
  },
  [`${HUB}.conversations`]: {
    columns: ['id', 'org_id', 'contact_id', 'status', 'assigned_to', 'assigned_at', 'ai_paused', 'last_message_at',
      'unread_count', 'closed_at', 'created_at', 'updated_at', 'zernio_conversation_id', 'pinned_note', 'archived',
      'channel', 'active_deal_id', 'zernio_account_id', 'provider', 'channel_id'],
    fks: { contact_id: `${HUB}.contacts` },
  },
  [`${HUB}.messages`]: {
    columns: ['id', 'org_id', 'conversation_id', 'direction', 'sender_type', 'sender_id', 'content_type', 'content',
      'media_url', 'meta_status', 'is_private_note', 'created_at', 'zernio_message_id', 'campaign_contact_id',
      'error_reason'],
  },
  [`${HUB}.templates`]: {
    columns: ['id', 'org_id', 'name', 'category', 'language', 'status', 'meta_template_id', 'meta_template_status',
      'header_type', 'header_content', 'body', 'footer', 'buttons', 'variables', 'ai_prompt', 'submitted_at',
      'approved_at', 'created_at', 'updated_at'],
  },
  [`${HUB}.deals`]: {
    columns: ['id', 'org_id', 'contact_id', 'pipeline_id', 'stage_id', 'title', 'value', 'currency', 'status',
      'expected_close', 'won_at', 'lost_at', 'owner_id', 'created_at', 'updated_at', 'lead_type', 'temperature',
      'last_purchase_at', 'archived_at'],
  },
  [`${HUB}.contact_tags`]: { columns: ['org_id', 'contact_id', 'tag_id', 'created_at'], unique: [['contact_id', 'tag_id']] },
  [`${HUB}.deal_tags`]: { columns: ['org_id', 'deal_id', 'tag_id'], unique: [['deal_id', 'tag_id']] },
  [`${HUB}.app_settings`]: {
    columns: ['org_id', 'id', 'business_hours', 'out_of_hours_message', 'created_at', 'updated_at', 'demo_mode',
      'auto_assign_enabled', 'auto_assign_last_user_id', 'sales_costs'],
    unique: [['org_id']],
  },
  [`${HUB}.ai_agent_config`]: {
    columns: ['id', 'org_id', 'system_prompt', 'temperature', 'max_tokens', 'is_active', 'created_at', 'updated_at',
      'model', 'timezone', 'variables', 'active_whatsapp', 'active_instagram', 'auto_move_leads'],
    unique: [['org_id']],
  },
  [`${HUB}.channels`]: {
    columns: ['id', 'org_id', 'provider', 'label', 'phone', 'zernio_account_id', 'uazapi_server_url',
      'uazapi_token_encrypted', 'webhook_secret', 'assigned_member', 'is_active', 'created_at', 'updated_at',
      'ai_enabled'],
  },
  [`${HUB}.campaigns`]: {
    columns: ['id', 'org_id', 'name', 'template_id', 'status', 'scheduled_at', 'audience_filter', 'variable_mapping',
      'total_contacts', 'sent', 'delivered', 'read', 'replied', 'failed', 'started_at', 'completed_at', 'created_at',
      'updated_at', 'zernio_broadcast_id', 'channel_id'],
  },
  [`${HUB}.campaign_contacts`]: {
    columns: ['id', 'org_id', 'campaign_id', 'contact_id', 'status', 'error_message', 'sent_at', 'delivered_at',
      'read_at', 'replied_at', 'created_at', 'updated_at', 'template_id_override', 'claimed_at', 'zernio_message_id',
      'zernio_conversation_id', 'zernio_broadcast_id'],
  },
  [`${HUB}.funnel_automations`]: {
    columns: ['id', 'org_id', 'pipeline_id', 'stage_id', 'name', 'is_active', 'actions', 'created_at', 'updated_at'],
  },
  [`${HUB}.crm_activities`]: {
    columns: ['id', 'org_id', 'contact_id', 'deal_id', 'project_id', 'type', 'title', 'body', 'due_at', 'done',
      'owner_id', 'created_at', 'done_at'],
  },
  'public.org_settings': { columns: ['org_id', 'key', 'value_encrypted', 'updated_at'], unique: [['org_id', 'key']] },
};

export interface ExternalCall {
  service: 'zernio' | 'uazapi';
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function pgError(status: number, code: string, message: string): Response {
  return json(status, { code, message, details: null, hint: null });
}

// Compara como o Postgres compararia pelo tipo da coluna: número com número,
// data com data (timestamptz e date), o resto como texto.
function compare(a: unknown, b: string): number {
  if (typeof a === 'number') return a - Number(b);
  if (typeof a === 'string' && ISO_DATE_RE.test(a) && ISO_DATE_RE.test(b)) return Date.parse(a) - Date.parse(b);
  return String(a).localeCompare(b);
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v;
}

class ColumnError extends Error {}

export class FakeBackend {
  readonly supabaseUrl: string;
  readonly tables = new Map<string, Row[]>();
  readonly externalCalls: ExternalCall[] = [];
  readonly restLog: string[] = [];
  // Falhas forçadas: (método, tabela) → resposta de erro do PostgREST.
  readonly forcedErrors: Array<{ method: string; table: string; status: number; code: string; message: string }> = [];
  // Falha forçada no envio pelo Zernio (simula recusa da Meta).
  zernioSendError: { status: number; error: string } | null = null;
  private realFetch: typeof fetch | null = null;
  private seq = 0;

  constructor(supabaseUrl: string) {
    this.supabaseUrl = supabaseUrl.replace(/\/+$/, '');
    for (const key of Object.keys(SCHEMA)) this.tables.set(key, []);
  }

  // ---- fixtures ----------------------------------------------------------------

  seed(table: string, rows: Row | Row[]): Row[] {
    const key = table.includes('.') ? table : `${HUB}.${table}`;
    const def = SCHEMA[key];
    if (!def) throw new Error(`fixture: tabela desconhecida ${key}`);
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) {
      for (const col of Object.keys(row)) {
        if (!def.columns.includes(col)) throw new Error(`fixture: coluna ${col} não existe em ${key}`);
      }
      this.tables.get(key)!.push(row);
    }
    return list;
  }

  rows(table: string): Row[] {
    return this.tables.get(table.includes('.') ? table : `${HUB}.${table}`) ?? [];
  }

  zernioMessages(): ExternalCall[] {
    return this.externalCalls.filter((c) => c.service === 'zernio' && /\/messages$/.test(c.path));
  }

  uazapiTexts(): ExternalCall[] {
    return this.externalCalls.filter((c) => c.service === 'uazapi' && c.path === '/send/text');
  }

  // ---- fetch ---------------------------------------------------------------------

  install(): void {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.route(new Request(input, init))) as typeof fetch;
  }

  restore(): void {
    if (this.realFetch) globalThis.fetch = this.realFetch;
    this.realFetch = null;
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.url.startsWith(`${this.supabaseUrl}/rest/v1/`)) return this.rest(req, url);
    if (url.hostname === 'zernio.com') return this.zernio(req, url);
    if (url.hostname.endsWith('uazapi.test')) return this.uazapi(req, url);
    throw new Error(`fetch inesperado no teste: ${req.method} ${req.url}`);
  }

  // ---- Zernio / UAZAPI --------------------------------------------------------------

  private async zernio(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = req.method === 'GET' ? {} : await req.json() as Record<string, unknown>;
    this.externalCalls.push({ service: 'zernio', method: req.method, path, body });
    if (req.method === 'POST' && path === '/inbox/conversations') {
      return json(200, { data: { conversationId: `zconv-${++this.seq}` } });
    }
    if (req.method === 'POST' && /^\/inbox\/conversations\/[^/]+\/messages$/.test(path)) {
      if (this.zernioSendError) return json(this.zernioSendError.status, { error: this.zernioSendError.error });
      return json(200, { id: `zmsg-${++this.seq}` });
    }
    return json(404, { error: `rota Zernio não simulada: ${req.method} ${path}` });
  }

  private async uazapi(req: Request, url: URL): Promise<Response> {
    const body = await req.json() as Record<string, unknown>;
    this.externalCalls.push({ service: 'uazapi', method: req.method, path: url.pathname, body });
    if (url.pathname === '/send/text') return json(200, { messageid: `umsg-${++this.seq}` });
    return json(404, { error: `rota UAZAPI não simulada: ${url.pathname}` });
  }

  // ---- PostgREST ----------------------------------------------------------------------

  private async rest(req: Request, url: URL): Promise<Response> {
    const name = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\//, ''));
    const schema = req.headers.get('Accept-Profile') ?? req.headers.get('Content-Profile') ?? 'public';
    this.restLog.push(`${req.method} ${schema}.${name}${url.search}`);

    if (name.startsWith('rpc/')) return this.rpc(name.slice(4), await req.json() as Row);

    const key = `${schema}.${name}`;
    const def = SCHEMA[key];
    if (!def) return pgError(404, 'PGRST205', `Could not find the table '${key}' in the schema cache`);
    const forced = this.forcedErrors.find((f) => f.method === req.method && f.table === name);
    if (forced) return pgError(forced.status, forced.code, forced.message);

    try {
      if (req.method === 'GET') return this.select(key, def, url, req);
      if (req.method === 'POST') return await this.insert(key, def, url, req);
      if (req.method === 'PATCH') return await this.update(key, def, url, req);
      if (req.method === 'DELETE') return this.remove(key, def, url);
    } catch (err) {
      if (err instanceof ColumnError) return pgError(400, '42703', err.message);
      throw err;
    }
    return pgError(405, 'PGRST000', `método não simulado: ${req.method}`);
  }

  private rpc(fn: string, args: Row): Response {
    if (fn === 'verify_service_token') return json(200, false);
    if (fn === 'bump_campaign_counter') {
      const row = this.rows('campaigns').find((c) => c.id === args.p_campaign_id);
      const column = String(args.p_column);
      if (row) row[column] = Number(row[column] ?? 0) + Number(args.p_delta ?? 0);
      return json(200, null);
    }
    return pgError(404, 'PGRST202', `Could not find the function ${fn}`);
  }

  private assertColumn(key: string, def: TableDef, col: string): void {
    if (!def.columns.includes(col)) throw new ColumnError(`column ${key}.${col} does not exist`);
  }

  private matches(key: string, def: TableDef, url: URL): (row: Row) => boolean {
    const tests: Array<(row: Row) => boolean> = [];
    for (const [col, raw] of url.searchParams) {
      if (RESERVED_PARAMS.has(col)) continue;
      this.assertColumn(key, def, col);
      let expr = raw;
      let negate = false;
      if (expr.startsWith('not.')) { negate = true; expr = expr.slice(4); }
      const dot = expr.indexOf('.');
      const op = expr.slice(0, dot);
      const value = expr.slice(dot + 1);
      let test: (row: Row) => boolean;
      if (op === 'eq') test = (r) => r[col] != null && String(r[col]) === value;
      else if (op === 'neq') test = (r) => r[col] != null && String(r[col]) !== value;
      else if (op === 'is') test = (r) => (value === 'null' ? r[col] == null : String(r[col]) === value);
      else if (op === 'in') {
        const list = splitTopLevel(value.replace(/^\(/, '').replace(/\)$/, '')).map(unquote);
        test = (r) => r[col] != null && list.includes(String(r[col]));
      } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        test = (r) => {
          if (r[col] == null) return false; // NULL nunca casa com comparação
          const c = compare(r[col], value);
          return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
        };
      } else throw new Error(`operador PostgREST não simulado: ${col}=${raw}`);
      tests.push(negate ? (r) => !test(r) : test);
    }
    return (row) => tests.every((t) => t(row));
  }

  private shape(key: string, def: TableDef, row: Row, select: string | null): Row {
    if (!select || select === '*') return { ...row };
    const out: Row = {};
    for (const part of splitTopLevel(select)) {
      const embed = part.match(/^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)\((.*)\)$/);
      if (embed) {
        const [, alias, hint, inner] = embed;
        const target = def.fks?.[hint];
        if (!target) throw new Error(`embed não simulado: ${key} → ${hint}`);
        const parent = (this.tables.get(target) ?? []).find((p) => p.id === row[hint]) ?? null;
        out[alias ?? hint] = parent ? this.shape(target, SCHEMA[target], parent, inner) : null;
        continue;
      }
      if (part === '*') { Object.assign(out, row); continue; }
      this.assertColumn(key, def, part);
      out[part] = row[part] ?? null;
    }
    return out;
  }

  private respondRows(rows: Row[], req: Request, status = 200): Response {
    if ((req.headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')) {
      if (rows.length !== 1) return pgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
      return json(status, rows[0]);
    }
    return json(status, rows);
  }

  private select(key: string, def: TableDef, url: URL, req: Request): Response {
    let rows = this.tables.get(key)!.filter(this.matches(key, def, url));
    const order = url.searchParams.get('order');
    if (order) {
      const specs = order.split(',').map((o) => {
        const [col, dir] = o.split('.');
        this.assertColumn(key, def, col);
        return { col, desc: dir === 'desc' };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, desc } of specs) {
          const c = a[col] == null ? (b[col] == null ? 0 : 1) : b[col] == null ? -1 : compare(a[col], String(b[col]));
          if (c !== 0) return desc ? -c : c;
        }
        return 0;
      });
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = url.searchParams.get('limit');
    rows = rows.slice(offset, limit ? offset + Number(limit) : undefined);
    const select = url.searchParams.get('select');
    return this.respondRows(rows.map((r) => this.shape(key, def, r, select)), req);
  }

  private async insert(key: string, def: TableDef, url: URL, req: Request): Promise<Response> {
    const payload = await req.json() as Row | Row[];
    const prefer = req.headers.get('Prefer') ?? '';
    const onConflict = url.searchParams.get('on_conflict')?.split(',') ?? null;
    const inserted: Row[] = [];
    const table = this.tables.get(key)!;
    for (const input of Array.isArray(payload) ? payload : [payload]) {
      for (const col of Object.keys(input)) this.assertColumn(key, def, col);
      const row: Row = { ...input };
      if (def.columns.includes('id') && row.id == null) row.id = crypto.randomUUID();
      for (const stamp of ['created_at', 'updated_at', 'sent_at']) {
        // sent_at só tem default em follow_up_log; nas outras tabelas nasce nulo.
        if (stamp === 'sent_at' && key !== `${HUB}.follow_up_log`) continue;
        if (def.columns.includes(stamp) && row[stamp] == null) row[stamp] = new Date().toISOString();
      }
      const clash = (def.unique ?? []).find((cols) =>
        table.some((existing) => cols.every((c) => existing[c] === row[c])));
      if (clash) {
        const sameTarget = onConflict && clash.length === onConflict.length && clash.every((c) => onConflict.includes(c));
        if (sameTarget && prefer.includes('resolution=ignore-duplicates')) continue;
        if (sameTarget && prefer.includes('resolution=merge-duplicates')) {
          Object.assign(table.find((existing) => clash.every((c) => existing[c] === row[c]))!, input);
          continue;
        }
        return pgError(409, '23505', `duplicate key value violates unique constraint on ${key} (${clash.join(', ')})`);
      }
      table.push(row);
      inserted.push(row);
    }
    if (!prefer.includes('return=representation')) return json(201, null);
    const select = url.searchParams.get('select');
    return this.respondRows(inserted.map((r) => this.shape(key, def, r, select)), req, 201);
  }

  private async update(key: string, def: TableDef, url: URL, req: Request): Promise<Response> {
    const patch = await req.json() as Row;
    for (const col of Object.keys(patch)) this.assertColumn(key, def, col);
    const hit = this.tables.get(key)!.filter(this.matches(key, def, url));
    for (const row of hit) Object.assign(row, patch);
    if (!(req.headers.get('Prefer') ?? '').includes('return=representation')) return json(204, null);
    return this.respondRows(hit.map((r) => this.shape(key, def, r, url.searchParams.get('select'))), req);
  }

  private remove(key: string, def: TableDef, url: URL): Response {
    const keep = this.tables.get(key)!.filter((r) => !this.matches(key, def, url)(r));
    this.tables.set(key, keep);
    return json(204, null);
  }
}

// ---- Carregar o handler de verdade da função --------------------------------------
// O index.ts chama Deno.serve(handler) no topo. Trocamos Deno.serve só durante o
// import para ficar com o handler na mão, sem abrir porta nenhuma.

export type Handler = (req: Request) => Response | Promise<Response>;

export async function loadEdgeHandler(indexUrl: string): Promise<Handler> {
  const realServe = Deno.serve;
  let captured: Handler | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (...args: unknown[]) => {
    captured = args.find((a) => typeof a === 'function') as Handler;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
  };
  try {
    await import(indexUrl);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  if (!captured) throw new Error(`${indexUrl} não chamou Deno.serve`);
  return captured;
}

export const TEST_ENV = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste',
  // 64 hex: chave AES-256 só de teste.
  CRYPTO_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
};

export function applyTestEnv(): void {
  for (const [k, v] of Object.entries(TEST_ENV)) Deno.env.set(k, v);
}

export function cronRequest(functionName: string, body: unknown = {}): Request {
  return new Request(`${TEST_ENV.SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_ENV.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
