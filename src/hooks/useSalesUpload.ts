import { useState } from 'react';
import * as XLSX from 'xlsx';
import { getSupabase } from '@/lib/supabase';

// Schema de colunas fixo do relatório do ERP (Ganso). Aceita variações comuns
// de cabeçalho (pt-BR) para cada campo interno.
const HEADER_ALIASES: Record<string, string[]> = {
  customer_name: ['cliente', 'nome', 'razao social', 'razão social'],
  customer_doc: ['cnpj', 'documento', 'cnpj/documento', 'doc', 'cpf'],
  customer_phone: ['telefone', 'celular', 'whatsapp', 'fone'],
  product_name: ['produto', 'item', 'descricao', 'descrição'],
  quantity: ['quantidade', 'qtd', 'qtde'],
  amount: ['valor', 'total', 'preco', 'preço'],
  purchase_date: ['data da compra', 'data', 'data compra', 'emissao', 'emissão'],
};

export interface SalesRowError {
  line: number;
  message: string;
}

export interface UploadResult {
  total: number;
  valid: number;
  inserted: number;
  duplicates: number;
  errors: SalesRowError[];
}

type ParsedRow = {
  customer_name: string | null;
  customer_doc: string | null;
  customer_phone: string | null;
  product_name: string;
  quantity: number;
  amount: number | null;
  purchase_date: string; // yyyy-mm-dd
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function resolveColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    const norm = normalizeHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.some((a) => norm === a)) map[field] = i;
    }
  });
  return map;
}

// Normaliza telefone para E.164 (BR): tira não-dígitos; 10-11 dígitos vira +55…
function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

function parseDate(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  // Serial do Excel (dias desde 1899-12-30). .xlsx guarda datas assim.
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    const ms = Math.round((value - 25569) * 86400 * 1000); // 25569 = 1899-12-30 → 1970-01-01
    const dt = new Date(ms);
    return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  const s = String(value ?? '').trim();
  if (!s) return null;
  // dd/mm/yyyy ou dd-mm-yyyy (BR — checado ANTES do Date() nativo, que leria
  // "01/02/2026" como US mm/dd e trocaria dia/mês).
  const br = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (br) {
    const [, d, m, y] = br;
    const year = y.length === 2 ? `20${y}` : y;
    const dd = Number(d);
    const mm = Number(m);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    return isNaN(new Date(iso).getTime()) ? null : iso;
  }
  // yyyy-mm-dd (ISO)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  // Números nativos (células numéricas do .xlsx) passam direto — convertê-los
  // via string mutilaria o decimal ("250.5" → "2505").
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  // Heurística BR: com vírgula ("1.234,56"), pontos são milhar e vírgula é
  // decimal. Sem vírgula ("250.5"), o ponto é decimal — não remover.
  const n = s.includes(',')
    ? Number(s.replace(/\./g, '').replace(',', '.'))
    : Number(s);
  return isNaN(n) ? null : n;
}

// Parser CSV mínimo (aceita ; ou , como separador, campos entre aspas com o
// separador dentro). Mantém cada célula como string — datas não são convertidas.
function parseCsv(text: string): string[][] {
  // Remove o BOM de CSVs exportados do Excel (charCode 0xFEFF no inicio).
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = clean.slice(0, clean.indexOf('\n') === -1 ? clean.length : clean.indexOf('\n'));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== '')) rows.push(row);
  }
  return rows;
}

// Campos do sistema para o popup de mapeamento (label + obrigatoriedade).
// customer_doc é obrigatório: é a chave de dedupe e do match da predição.
export const SALES_FIELDS: { key: keyof typeof HEADER_ALIASES; label: string; required: boolean }[] = [
  { key: 'customer_name', label: 'Cliente', required: false },
  { key: 'customer_doc', label: 'CNPJ / Documento', required: true },
  { key: 'customer_phone', label: 'Telefone', required: false },
  { key: 'product_name', label: 'Produto', required: true },
  { key: 'quantity', label: 'Quantidade', required: true },
  { key: 'amount', label: 'Valor', required: false },
  { key: 'purchase_date', label: 'Data da compra', required: true },
];

export interface PreparedSheet {
  fileName: string;
  allRows: unknown[][];        // planilha completa (para trocar a linha de cabeçalho)
  headerRowIndex: number;      // índice (0-based) da linha usada como cabeçalho
  headers: string[];
  rows: unknown[][];           // linhas de dados (após o cabeçalho)
  suggested: Record<string, number>; // mapeamento auto-detectado (campo → índice)
}

// Recalcula cabeçalho/linhas/sugestão a partir de outra linha de cabeçalho —
// relatórios de ERP costumam ter um TÍTULO na linha 1 e o cabeçalho real abaixo.
export function withHeaderRow(sheet: PreparedSheet, headerRowIndex: number): PreparedSheet {
  const idx = Math.max(0, Math.min(headerRowIndex, sheet.allRows.length - 2));
  const headers = (sheet.allRows[idx] as unknown[]).map((h) => String(h ?? ''));
  return {
    ...sheet,
    headerRowIndex: idx,
    headers,
    rows: sheet.allRows.slice(idx + 1),
    suggested: resolveColumns(headers),
  };
}

// Heurística: a linha de cabeçalho é a que tem mais células preenchidas entre
// as 10 primeiras (título de tabela ocupa 1 célula; o cabeçalho ocupa várias).
function detectHeaderRow(allRows: unknown[][]): number {
  let best = 0;
  let bestCount = -1;
  const limit = Math.min(10, Math.max(1, allRows.length - 1));
  for (let i = 0; i < limit; i++) {
    const count = (allRows[i] as unknown[]).filter((c) => String(c ?? '').trim() !== '').length;
    if (count > bestCount) { best = i; bestCount = count; }
  }
  return best;
}

export function useSalesUpload() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  // Etapa 1: lê a planilha e sugere o mapeamento — a UI abre o popup para o
  // usuário confirmar/ajustar antes de importar.
  async function prepare(file: File): Promise<PreparedSheet | { error: string }> {
    // CSV: parse manual em texto puro — o SheetJS pré-interpreta datas de CSV
    // como US mm/dd (trocaria dia/mês). Assim "01/02/2026" chega como string
    // e o parser dd/mm decide. .xlsx: sem cellDates, datas chegam como serial
    // numérico e o parseDate converte com aritmética UTC pura.
    let all: unknown[][];
    if (/\.csv$/i.test(file.name)) {
      all = parseCsv(await file.text());
    } else {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, raw: true });
    }
    if (all.length < 2) return { error: 'Planilha vazia ou sem cabeçalho.' };
    const headerRowIndex = detectHeaderRow(all);
    const headers = (all[headerRowIndex] as unknown[]).map((h) => String(h ?? ''));
    return {
      fileName: file.name,
      allRows: all,
      headerRowIndex,
      headers,
      rows: all.slice(headerRowIndex + 1),
      suggested: resolveColumns(headers),
    };
  }

  // Etapa 2: valida e importa com o mapeamento confirmado pelo usuário.
  async function commit(sheet: PreparedSheet, cols: Record<string, number>): Promise<UploadResult> {
    setBusy(true);
    setResult(null);
    try {
      const rows: unknown[][] = [[], ...sheet.rows]; // shim p/ manter índices 1-based do laço
      const errors: SalesRowError[] = [];
      const missing = SALES_FIELDS.filter((f) => f.required && cols[f.key] === undefined).map((f) => f.label);
      if (missing.length) {
        const r = {
          total: 0, valid: 0, inserted: 0, duplicates: 0,
          errors: [{ line: 1, message: `Mapeie as colunas obrigatórias: ${missing.join(', ')}.` }],
        };
        setResult(r);
        return r;
      }

      const valid: ParsedRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        const line = i + 1; // 1-based, contando o cabeçalho
        const product = String(row[cols.product_name] ?? '').trim();
        if (!product) {
          errors.push({ line, message: 'produto vazio' });
          continue;
        }
        const qty = num(row[cols.quantity]);
        if (qty === null) {
          errors.push({ line, message: 'quantidade inválida' });
          continue;
        }
        const date = parseDate(cols.purchase_date !== undefined ? row[cols.purchase_date] : null);
        if (!date) {
          errors.push({ line, message: 'data da compra inválida' });
          continue;
        }
        const doc = String(row[cols.customer_doc] ?? '').trim();
        if (!doc) {
          errors.push({ line, message: 'CNPJ/Documento vazio (chave de identificação do cliente)' });
          continue;
        }
        valid.push({
          customer_name: cols.customer_name !== undefined ? String(row[cols.customer_name] ?? '').trim() || null : null,
          customer_doc: doc,
          customer_phone: toE164(cols.customer_phone !== undefined ? String(row[cols.customer_phone] ?? '') : null),
          product_name: product,
          quantity: qty,
          amount: cols.amount !== undefined ? num(row[cols.amount]) : null,
          purchase_date: date,
        });
      }

      let inserted = 0;
      let duplicates = 0;
      if (valid.length) {
        const supabase = getSupabase();
        const before = await supabase.from('sales_records').select('id', { count: 'exact', head: true });
        // upsert idempotente por (customer_doc, product_name, purchase_date)
        const { error } = await supabase
          .from('sales_records')
          .upsert(
            valid.map((v) => ({ ...v, source_file: sheet.fileName })),
            { onConflict: 'customer_doc,product_name,purchase_date', ignoreDuplicates: true },
          );
        if (error) {
          const r = { total: rows.length - 1, valid: valid.length, inserted: 0, duplicates: 0, errors: [{ line: 0, message: `Falha ao salvar: ${error.message}` }] };
          setResult(r);
          return r;
        }
        const after = await supabase.from('sales_records').select('id', { count: 'exact', head: true });
        inserted = (after.count ?? 0) - (before.count ?? 0);
        duplicates = valid.length - inserted;
      }

      const r: UploadResult = { total: rows.length - 1, valid: valid.length, inserted, duplicates, errors };
      setResult(r);
      return r;
    } finally {
      setBusy(false);
    }
  }

  return { prepare, commit, busy, result };
}
