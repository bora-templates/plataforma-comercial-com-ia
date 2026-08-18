import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Loader2, MoreVertical, RefreshCw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useSalesUpload, withHeaderRow, SALES_FIELDS, type PreparedSheet } from '@/hooks/useSalesUpload';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VOCAB } from '@/config/vocab';

interface Metrics {
  total_records: number;
  active_customers: number;
  avg_products_per_customer: number;
  avg_ticket: number;
  avg_repurchase_interval: number;
  top_products: { product: string; compras: number; qtd: number }[];
  at_risk_count: number;
}

interface Prediction {
  id: string;
  customer_name: string | null;
  customer_doc: string;
  customer_phone: string;
  product_name: string;
  avg_interval_days: number;
  purchase_count: number;
  last_purchase: string;
  predicted_next: string;
  status: string;
}

// Um cliente agrupa todas as suas predições (uma por produto) em UMA linha.
interface ClientGroup {
  key: string;
  primary: Prediction;                 // predição mais urgente (próxima prevista mais cedo)
  products: { name: string; quantity: number }[];
  lastPurchase: string;                // compra mais recente do cliente
}

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STATUS_OPTIONS = ['pending', 'sent', 'converted', 'snoozed'];

const inputCls =
  'w-full rounded-lg border border-[rgba(var(--accent-rgb),0.2)] bg-[rgba(var(--surface-rgb),0.03)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const selectCls = `${inputCls} [&>option]:bg-[var(--bg-primary)]`;

export default function VendasPage() {
  const { role } = useAppUser();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();
  const { prepare, commit, busy, result } = useSalesUpload();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [autoSend, setAutoSend] = useState<boolean | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [computing, setComputing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Popup de mapeamento (abre após selecionar o arquivo)
  const [sheet, setSheet] = useState<PreparedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  // Menu de 3 pontinhos + edição — posição fixa para não ser clipado pelo overflow da tabela
  const [menuFor, setMenuFor] = useState<{ id: string; top: number; left: number } | null>(null);
  const [editing, setEditing] = useState<Prediction | null>(null);
  const [dispatching, setDispatching] = useState<string | null>(null);
  // Popup com a lista de produtos comprados por um cliente (quando tem vários).
  const [productsFor, setProductsFor] = useState<ClientGroup | null>(null);

  // Agrupa as predições por cliente: uma linha por cliente, produtos somados.
  const groups = useMemo<ClientGroup[]>(() => {
    const map = new Map<string, Prediction[]>();
    for (const p of predictions) {
      const key = p.customer_doc || p.customer_phone || p.id;
      const arr = map.get(key);
      if (arr) arr.push(p);
      else map.set(key, [p]);
    }
    const result = Array.from(map.entries()).map(([key, preds]) => {
      const sorted = [...preds].sort((a, b) => a.predicted_next.localeCompare(b.predicted_next));
      const lastPurchase = preds.reduce((m, p) => (p.last_purchase > m ? p.last_purchase : m), preds[0].last_purchase);
      return {
        key,
        primary: sorted[0],
        products: sorted.map((p) => ({ name: p.product_name, quantity: p.purchase_count ?? 1 })),
        lastPurchase,
      };
    });
    result.sort((a, b) => a.primary.predicted_next.localeCompare(b.primary.predicted_next));
    return result;
  }, [predictions]);

  const reload = useCallback(async () => {
    const supabase = getSupabase();
    const [m, p, cfg] = await Promise.all([
      supabase.rpc('sales_dashboard', { p_window_days: 90 }),
      supabase
        .from('repurchase_predictions')
        .select('id, customer_name, customer_doc, customer_phone, product_name, avg_interval_days, purchase_count, last_purchase, predicted_next, status')
        .order('predicted_next', { ascending: true })
        .limit(200),
      supabase.from('repurchase_config').select('auto_send, template_name').eq('id', 1).maybeSingle(),
    ]);
    if (m.data) setMetrics(m.data as Metrics);
    setPredictions((p.data ?? []) as Prediction[]);
    const cfgRow = cfg.data as { auto_send?: boolean; template_name?: string | null } | null;
    setAutoSend(Boolean(cfgRow?.auto_send));
    setTemplateName(cfgRow?.template_name ?? '');
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Seleção de arquivo → lê e abre o popup de mapeamento com sugestão automática.
  const handleFile = async (file: File) => {
    const prepared = await prepare(file);
    if ('error' in prepared) {
      toast.error(prepared.error);
      return;
    }
    setMapping(prepared.suggested);
    setSheet(prepared);
  };

  const confirmImport = async () => {
    if (!sheet) return;
    const cols: Record<string, number> = {};
    for (const [k, v] of Object.entries(mapping)) if (v !== undefined) cols[k] = v;
    const missing = SALES_FIELDS.filter((f) => f.required && cols[f.key] === undefined);
    if (missing.length) {
      toast.error(`Mapeie as colunas obrigatórias: ${missing.map((f) => f.label).join(', ')}.`);
      return;
    }
    const r = await commit(sheet, cols);
    setSheet(null);
    if (r.errors.length && r.valid === 0) toast.error('Nenhuma linha válida no arquivo.');
    else toast.success(`${r.inserted} novo(s), ${r.duplicates} já existente(s).`);
    await reload();
  };

  const runPrediction = async () => {
    setComputing(true);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.rpc('compute_repurchase_predictions');
      if (error) throw new Error(error.message);
      toast.success(`Predição atualizada: ${data} par(es) cliente+produto.`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao rodar predição.');
    } finally {
      setComputing(false);
    }
  };

  const toggleAutoSend = async () => {
    const next = !autoSend;
    if (next && !templateName.trim()) {
      toast.error('Configure o nome do template de recompra antes de ligar o disparo.');
      return;
    }
    setAutoSend(next);
    const supabase = getSupabase();
    const { error } = await supabase.from('repurchase_config').update({ auto_send: next, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) {
      setAutoSend(!next);
      toast.error('Falha ao alterar o disparo automático.');
    } else {
      toast.success(next ? 'Disparo automático LIGADO.' : 'Disparo automático desligado.');
    }
  };

  const saveTemplateName = async () => {
    setSavingTemplate(true);
    const supabase = getSupabase();
    const { error } = await supabase
      .from('repurchase_config')
      .update({ template_name: templateName.trim() || null, updated_at: new Date().toISOString() })
      .eq('id', 1);
    setSavingTemplate(false);
    if (error) toast.error('Falha ao salvar o template.');
    else toast.success('Template de recompra salvo.');
  };

  // Cliente clicável → ficha do contato (match por telefone E.164).
  const openContact = async (p: Prediction) => {
    const phone = (p.customer_phone ?? '').trim();
    if (!phone) {
      toast.error('Predição sem telefone — não há contato para abrir.');
      return;
    }
    const supabase = getSupabase();
    const { data } = await supabase.from('contacts').select('id').eq('phone', phone).maybeSingle();
    if (data) navigate(`/contacts/${(data as { id: string }).id}`);
    else toast.error('Contato não encontrado na base.', { description: `Nenhum contato com o telefone ${phone}.` });
  };

  // Disparo manual de UMA predição (repurchase-dispatch em modo manual).
  const dispatchNow = async (p: Prediction) => {
    setMenuFor(null);
    setDispatching(p.id);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.functions.invoke('repurchase-dispatch', {
        body: { prediction_id: p.id },
      });
      if (error) throw new Error(error.message);
      const res = data as { ok?: boolean; sent?: number; skipped?: string; errors?: string[] };
      if (res?.sent && res.sent > 0) toast.success('Mensagem de recompra disparada.');
      else if (res?.skipped === 'template_not_configured') toast.error('Configure o template de recompra antes de disparar.');
      else toast.error('Disparo não realizado.', { description: res?.errors?.[0] ?? res?.skipped ?? 'Verifique o telefone e o template.' });
      await reload();
    } catch (err) {
      toast.error('Falha ao disparar', { description: err instanceof Error ? err.message : 'Erro interno' });
    } finally {
      setDispatching(null);
    }
  };

  const removePrediction = async (p: Prediction) => {
    setMenuFor(null);
    if (!confirm(`Remover ${p.customer_name ?? p.customer_doc} · ${p.product_name} da lista?`)) return;
    const supabase = getSupabase();
    const { error } = await supabase.from('repurchase_predictions').delete().eq('id', p.id);
    if (error) toast.error('Falha ao remover', { description: error.message });
    else {
      setPredictions((prev) => prev.filter((x) => x.id !== p.id));
      toast.success('Removido da lista.');
    }
  };

  const saveEdit = async (patch: Prediction) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('repurchase_predictions')
      .update({
        customer_name: patch.customer_name?.trim() || null,
        customer_doc: patch.customer_doc.trim(),
        customer_phone: patch.customer_phone.trim(),
        product_name: patch.product_name.trim(),
        avg_interval_days: Math.max(1, Number(patch.avg_interval_days) || 1),
        last_purchase: patch.last_purchase,
        predicted_next: patch.predicted_next,
        status: patch.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', patch.id);
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
      return;
    }
    toast.success('Predição atualizada.');
    setEditing(null);
    await reload();
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Título + botão de upload na MESMA linha */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">{VOCAB.sales} &amp; Recompra</h1>
          </div>
        </div>
        {isAdmin && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-[var(--accent-deep)] to-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--on-accent)] transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Subir Excel/CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
            />
          </>
        )}
      </div>

      {/* Resultado do upload */}
      {result && (
        <div className="glass-card p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-[var(--color-text-primary)]"><b>{result.total}</b> linhas lidas</span>
            <span className="text-[#10B981]"><b>{result.inserted}</b> novas</span>
            <span className="text-[var(--color-text-secondary)]"><b>{result.duplicates}</b> já existentes (dedupe)</span>
            {result.errors.length > 0 && <span className="text-[#EF4444]"><b>{result.errors.length}</b> com erro</span>}
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-[#EF4444]">
              {result.errors.slice(0, 50).map((e, i) => (
                <li key={i}>Linha {e.line}: {e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Métricas */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Metric label="Clientes ativos (90d)" value={String(metrics?.active_customers ?? 0)} />
        <Metric label="Ticket médio" value={brl(metrics?.avg_ticket ?? 0)} />
        <Metric label="Média produtos/cliente" value={String(metrics?.avg_products_per_customer ?? 0)} />
      </div>

      {/* Predição / kill-switch */}
      <div className="glass-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-label">Predição de recompra</div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <button
                onClick={runPrediction}
                disabled={computing}
                className="inline-flex items-center gap-2 rounded-lg border border-[rgba(var(--accent-rgb),0.25)] px-3 py-1.5 text-xs font-medium text-[var(--accent-secondary)] transition hover:border-[var(--accent-primary)] disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${computing ? 'animate-spin' : ''}`} /> Rodar agora
              </button>
            )}
            {isAdmin && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-primary)]">
                <input type="checkbox" checked={autoSend === true} onChange={toggleAutoSend} className="h-4 w-4 accent-[var(--accent-primary)]" />
                Disparo automático (WABA)
              </label>
            )}
          </div>
        </div>
        {autoSend === false && (
          <p className="mt-2 text-xs text-[var(--color-text-secondary)] opacity-80">
            Disparo automático desligado (kill-switch). O cron calcula as predições diariamente, mas nenhuma mensagem é enviada até você ligar.
          </p>
        )}

        {isAdmin && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="text-xs text-[var(--color-text-secondary)] shrink-0">Template de recompra (aprovado na Meta):</span>
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="ex: reposicao_estoque"
              className="flex-1 rounded-lg border border-[rgba(var(--accent-rgb),0.2)] bg-[rgba(var(--surface-rgb),0.03)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <button
              onClick={saveTemplateName}
              disabled={savingTemplate}
              className="rounded-lg border border-[rgba(var(--accent-rgb),0.25)] px-3 py-1.5 text-xs font-medium text-[var(--accent-secondary)] transition hover:border-[var(--accent-primary)] disabled:opacity-60"
            >
              {savingTemplate ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-secondary)]">
              <tr>
                <th className="pb-2 font-medium">Cliente</th>
                <th className="pb-2 font-medium">Produto</th>
                <th className="pb-2 font-medium">Ciclo de compra</th>
                <th className="pb-2 font-medium">Última compra</th>
                <th className="pb-2 font-medium">Próxima prevista</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={7} className="py-6 text-center text-[var(--color-text-secondary)] opacity-70">Sem predições ainda. Suba um relatório com histórico e rode a predição.</td></tr>
              ) : (
                groups.map((g) => {
                  const p = g.primary;
                  return (
                  <tr key={g.key} className="border-t border-[rgba(var(--accent-rgb),0.08)]">
                    <td className="py-2">
                      <button
                        onClick={() => void openContact(p)}
                        className="text-left text-[var(--color-text-primary)] underline decoration-[rgba(var(--accent-rgb),0.4)] underline-offset-2 transition hover:text-[var(--accent-secondary)]"
                        title="Abrir ficha do contato"
                      >
                        {p.customer_name ?? p.customer_doc}
                      </button>
                    </td>
                    <td className="py-2 text-[var(--color-text-secondary)]">
                      {g.products.length > 1 ? (
                        <button
                          onClick={() => setProductsFor(g)}
                          className="text-left underline decoration-[rgba(var(--accent-rgb),0.4)] underline-offset-2 transition hover:text-[var(--accent-secondary)]"
                          title="Ver todos os produtos comprados"
                        >
                          {g.products[0].name} e outros
                        </button>
                      ) : (
                        g.products[0]?.name
                      )}
                    </td>
                    <td className="py-2 text-[var(--color-text-secondary)]">{p.avg_interval_days}d</td>
                    <td className="py-2 text-[var(--color-text-secondary)]">{g.lastPurchase}</td>
                    <td className="py-2 text-[var(--color-text-primary)]">{p.predicted_next}</td>
                    <td className="py-2"><span className="rounded-full bg-[rgba(var(--accent-rgb),0.12)] px-2 py-0.5 text-xs text-[var(--accent-secondary)]">{p.status}</span></td>
                    <td className="py-2 text-right">
                      <div className="relative inline-block">
                        <button
                          onClick={(e) => {
                            if (menuFor?.id === p.id) { setMenuFor(null); return; }
                            const r = e.currentTarget.getBoundingClientRect();
                            // w-52 = 208px; alinha a borda direita do menu à do botão
                            setMenuFor({ id: p.id, top: r.bottom + 4, left: Math.max(8, r.right - 208) });
                          }}
                          aria-label="Ações"
                          className="rounded-md p-1 text-[var(--color-text-secondary)] transition hover:bg-[rgba(var(--surface-rgb),0.05)] hover:text-[var(--color-text-primary)]"
                        >
                          {dispatching === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
                        </button>
                        {menuFor?.id === p.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                            <div
                              style={{ position: 'fixed', top: menuFor.top, left: menuFor.left }}
                              className="z-20 w-52 rounded-lg border border-[rgba(var(--accent-rgb),0.25)] bg-[var(--bg-primary)] p-1 text-left shadow-[0_0_30px_rgba(var(--accent-rgb),0.15)]"
                            >
                              <button onClick={() => void dispatchNow(p)} className="block w-full rounded-md px-3 py-2 text-left text-xs text-[var(--color-text-primary)] transition hover:bg-[rgba(var(--surface-rgb),0.05)]">
                                Disparar mensagem agora
                              </button>
                              <button onClick={() => { setMenuFor(null); setEditing({ ...p }); }} className="block w-full rounded-md px-3 py-2 text-left text-xs text-[var(--color-text-primary)] transition hover:bg-[rgba(var(--surface-rgb),0.05)]">
                                Editar informações
                              </button>
                              <button onClick={() => void removePrediction(p)} className="block w-full rounded-md px-3 py-2 text-left text-xs text-[var(--color-error)] transition hover:bg-[rgba(var(--surface-rgb),0.05)]">
                                Remover da lista
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

      </div>

      {/* Popup: mapeamento de colunas */}
      {sheet && (
        <Dialog open onClose={() => setSheet(null)} title="Mapear colunas da planilha">
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Atrele cada coluna de <b className="text-[var(--color-text-primary)]">{sheet.fileName}</b> ao campo
              correspondente do sistema. Campos com * são obrigatórios.
            </p>
            {/* Linha do cabeçalho — relatórios com título na 1ª linha */}
            <div className="grid grid-cols-[160px_1fr] items-center gap-2">
              <span className="text-sm text-[var(--color-text-label)]">Linha do cabeçalho</span>
              <select
                value={sheet.headerRowIndex}
                onChange={(e) => {
                  const next = withHeaderRow(sheet, Number(e.target.value));
                  setSheet(next);
                  setMapping(next.suggested);
                }}
                className={selectCls}
              >
                {sheet.allRows.slice(0, Math.min(10, sheet.allRows.length - 1)).map((r, i) => (
                  <option key={i} value={i}>
                    Linha {i + 1}: {(r as unknown[]).map((c) => String(c ?? '')).filter(Boolean).slice(0, 4).join(' · ').slice(0, 60) || '(vazia)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              {SALES_FIELDS.map((f) => (
                <div key={f.key} className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="text-sm text-[var(--color-text-label)]">
                    {f.label}{f.required ? ' *' : ''}
                  </span>
                  <select
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                    className={selectCls}
                  >
                    <option value="">— não importar —</option>
                    {sheet.headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {/* Amostra das 3 primeiras linhas para conferência */}
            <div className="max-h-32 overflow-auto rounded-lg border border-[rgba(var(--accent-rgb),0.12)] bg-[rgba(var(--surface-rgb),0.02)] p-2 text-[11px] text-[var(--color-text-secondary)]">
              {sheet.rows.slice(0, 3).map((r, i) => (
                <div key={i} className="truncate">{(r as unknown[]).map((c) => String(c ?? '')).join(' · ')}</div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSheet(null)}>Cancelar</Button>
              <Button onClick={() => void confirmImport()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Importar
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Popup: produtos comprados pelo cliente */}
      {productsFor && (
        <Dialog
          open
          onClose={() => setProductsFor(null)}
          title={`Produtos de ${productsFor.primary.customer_name ?? productsFor.primary.customer_doc}`}
        >
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {productsFor.products.length} produto(s) comprado(s) por este cliente.
            </p>
            <div className="overflow-hidden rounded-lg border border-[rgba(var(--accent-rgb),0.12)]">
              <table className="w-full text-sm">
                <thead className="bg-[rgba(var(--surface-rgb),0.03)] text-left text-[var(--color-text-secondary)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Produto</th>
                    <th className="px-3 py-2 font-medium text-right">Quantidade</th>
                  </tr>
                </thead>
                <tbody>
                  {productsFor.products.map((pr, i) => (
                    <tr key={i} className="border-t border-[rgba(var(--accent-rgb),0.08)]">
                      <td className="px-3 py-2 text-[var(--color-text-primary)]">{pr.name}</td>
                      <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{pr.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setProductsFor(null)}>Fechar</Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Popup: editar predição */}
      {editing && (
        <Dialog open onClose={() => setEditing(null)} title="Editar informações">
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label>Cliente</Label>
                <Input value={editing.customer_name ?? ''} onChange={(e) => setEditing({ ...editing, customer_name: e.target.value })} /></div>
              <div className="space-y-1"><Label>CNPJ / Documento</Label>
                <Input value={editing.customer_doc} onChange={(e) => setEditing({ ...editing, customer_doc: e.target.value })} /></div>
              <div className="space-y-1"><Label>Telefone</Label>
                <Input value={editing.customer_phone} onChange={(e) => setEditing({ ...editing, customer_phone: e.target.value })} /></div>
              <div className="space-y-1"><Label>Produto</Label>
                <Input value={editing.product_name} onChange={(e) => setEditing({ ...editing, product_name: e.target.value })} /></div>
              <div className="space-y-1"><Label>Ciclo de compra (dias)</Label>
                <Input type="number" min={1} value={editing.avg_interval_days} onChange={(e) => setEditing({ ...editing, avg_interval_days: Number(e.target.value) })} /></div>
              <div className="space-y-1"><Label>Status</Label>
                <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })} className={selectCls}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select></div>
              <div className="space-y-1"><Label>Última compra</Label>
                <Input type="date" value={editing.last_purchase} onChange={(e) => setEditing({ ...editing, last_purchase: e.target.value })} /></div>
              <div className="space-y-1"><Label>Próxima prevista</Label>
                <Input type="date" value={editing.predicted_next} onChange={(e) => setEditing({ ...editing, predicted_next: e.target.value })} /></div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button onClick={() => void saveEdit(editing)}>Salvar</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass-card p-5">
      <div className="text-label">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${accent ? 'text-[#F59E0B]' : 'text-display'}`}>{value}</div>
    </div>
  );
}
