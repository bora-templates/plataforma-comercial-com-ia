import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase';

// Editor do mapa de canal (tabela whatsapp_hub.utm_channel_map) — é ESTA tabela
// que a trigger _derive_deal_traffic consulta para derivar traffic_type e
// origin_channel dos leads. Substitui o antigo editor de aliases (JSONB órfão
// em app_settings.utm_channel_map, que a trigger não lê mais).

interface MapRule {
  id: string;
  match_type: 'source' | 'medium' | 'source_medium' | 'campaign_pattern';
  match_value: string;
  traffic_type: string;
  origin_channel: string;
  priority: number;
}

const MATCH_TYPES: { value: MapRule['match_type']; label: string; hint: string }[] = [
  { value: 'source_medium', label: 'source + medium', hint: 'ex.: ig|paid_social' },
  { value: 'source', label: 'source', hint: 'ex.: instagram' },
  { value: 'medium', label: 'medium', hint: 'ex.: paid_social' },
  { value: 'campaign_pattern', label: 'campanha (LIKE)', hint: 'ex.: %blackfriday%' },
];

const TRAFFIC_TYPES = ['pago', 'organico', 'manual'];

const ORIGIN_CHANNELS = [
  'instagram_ads', 'facebook_ads', 'meta_ads', 'google_ads', 'tiktok_ads',
  'linkedin_ads', 'youtube_ads', 'instagram_organico', 'facebook_organico',
  'google_organico', 'tiktok_organico', 'linkedin_organico', 'whatsapp_direto', 'outro',
];

interface NewRule {
  match_type: MapRule['match_type'];
  match_value: string;
  traffic_type: string;
  origin_channel: string;
  priority: string;
}

const EMPTY_NEW: NewRule = {
  match_type: 'source_medium',
  match_value: '',
  traffic_type: 'pago',
  origin_channel: 'meta_ads',
  priority: '100',
};

const selectCls =
  'rounded-lg border border-[rgba(212,165,116,0.2)] bg-white/[0.03] px-2 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)] [&>option]:bg-[#0A0A0F]';

export function UtmChannelMapEditor() {
  const [rules, setRules] = useState<MapRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<NewRule>(EMPTY_NEW);

  const reload = useCallback(async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('utm_channel_map')
      .select('*')
      .order('priority', { ascending: false })
      .order('match_value');
    if (error) toast.error('Falha ao carregar regras', { description: error.message });
    setRules((data ?? []) as MapRule[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addRule = async () => {
    const value = draft.match_value.trim().toLowerCase();
    if (!value) {
      toast.error('Informe o valor a casar (ex.: ig|paid_social).');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase.from('utm_channel_map').insert({
      match_type: draft.match_type,
      match_value: value,
      traffic_type: draft.traffic_type,
      origin_channel: draft.origin_channel,
      priority: Number(draft.priority) || 100,
    });
    setSaving(false);
    if (error) {
      toast.error('Falha ao adicionar', { description: error.message });
      return;
    }
    toast.success('Regra adicionada.');
    setDraft(EMPTY_NEW);
    void reload();
  };

  const removeRule = async (id: string) => {
    const supabase = getSupabase();
    const { error } = await supabase.from('utm_channel_map').delete().eq('id', id);
    if (error) {
      toast.error('Falha ao remover', { description: error.message });
      return;
    }
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="text-label">Derivação de origem</div>
        <h2 className="text-xl font-bold text-display">Regras de canal (UTM)</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Cada lead novo tem <code>traffic_type</code> e <code>origin_channel</code> derivados destas
          regras (maior prioridade vence). Ex.: <code>ig|paid_social → pago / instagram_ads</code>.
        </p>
      </header>

      {/* Nova regra */}
      <div className="glass-card space-y-3 p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
          <select
            value={draft.match_type}
            onChange={(e) => setDraft((d) => ({ ...d, match_type: e.target.value as MapRule['match_type'] }))}
            className={selectCls}
          >
            {MATCH_TYPES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <Input
            value={draft.match_value}
            onChange={(e) => setDraft((d) => ({ ...d, match_value: e.target.value }))}
            placeholder={MATCH_TYPES.find((m) => m.value === draft.match_type)?.hint}
            className="font-mono"
          />
          <select
            value={draft.traffic_type}
            onChange={(e) => setDraft((d) => ({ ...d, traffic_type: e.target.value }))}
            className={selectCls}
          >
            {TRAFFIC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={draft.origin_channel}
            onChange={(e) => setDraft((d) => ({ ...d, origin_channel: e.target.value }))}
            className={selectCls}
          >
            {ORIGIN_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={draft.priority}
              onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
              placeholder="prioridade"
              className="w-24"
            />
            <Button type="button" onClick={addRule} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Adicionar
            </Button>
          </div>
        </div>
      </div>

      {/* Lista */}
      <div className="glass-card p-4">
        {loading ? (
          <div className="py-8 text-center text-label opacity-60">Carregando...</div>
        ) : rules.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-secondary)] opacity-60">
            Nenhuma regra — leads com UTM não mapeada caem em “outro”.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgba(212,165,116,0.08)] bg-white/[0.02] px-3 py-2"
              >
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
                  {MATCH_TYPES.find((m) => m.value === r.match_type)?.label ?? r.match_type}
                </span>
                <code className="text-xs text-[var(--color-text-primary)]">{r.match_value}</code>
                <span className="text-[var(--color-text-secondary)]">→</span>
                <span className={`text-xs font-semibold ${r.traffic_type === 'pago' ? 'text-[var(--accent-secondary)]' : r.traffic_type === 'organico' ? 'text-[#34D399]' : 'text-[#CBD5E1]'}`}>
                  {r.traffic_type}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">/ {r.origin_channel}</span>
                <span className="ml-auto text-[10px] text-[var(--color-text-secondary)] opacity-60">
                  prio {r.priority}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void removeRule(r.id)}
                  aria-label="Remover regra"
                >
                  <Trash2 className="h-4 w-4 text-[var(--color-error)]" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
