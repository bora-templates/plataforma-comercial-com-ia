import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GripVertical, Plus, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useOperators } from '@/hooks/useOperators';

// Fila de distribuição automática de leads no handoff. A ordem (position) define
// a sequência do round-robin; o toggle liga/desliga a atribuição automática.
// Persistência direta (padrão de BusinessHoursSettings), gated a admin.
export function LeadAssignmentSettings() {
  const { userId, role } = useAppUser();
  const isAdmin = role === 'admin';
  const { operators } = useOperators();

  const [enabled, setEnabled] = useState(false);
  const [queue, setQueue] = useState<string[]>([]); // user_ids em ordem de position
  const [loading, setLoading] = useState(true);
  const dragIdx = useRef<number | null>(null);

  const emailOf = (uid: string) => operators.find((o) => o.user_id === uid)?.email ?? uid;

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabase();
    void (async () => {
      const [cfgRes, queueRes] = await Promise.all([
        supabase.from('app_settings').select('auto_assign_enabled').eq('id', 1).maybeSingle(),
        supabase
          .schema('whatsapp_hub')
          .from('lead_assignment_queue')
          .select('user_id, position')
          .order('position', { ascending: true }),
      ]);
      setEnabled(Boolean((cfgRes.data as { auto_assign_enabled?: boolean } | null)?.auto_assign_enabled));
      setQueue(((queueRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
      setLoading(false);
    })();
  }, [userId]);

  const inQueue = new Set(queue);
  const available = operators.filter((o) => !inQueue.has(o.user_id));

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    const supabase = getSupabase();
    const { error } = await supabase.from('app_settings').update({ auto_assign_enabled: next }).eq('id', 1);
    if (error) {
      setEnabled(!next);
      toast.error('Falha ao salvar', { description: error.message });
    } else {
      toast.success(next ? 'Atribuição automática ativada.' : 'Atribuição automática desativada.');
    }
  };

  // Persiste a ordem inteira (positions = índice) — batch, como reorderStages.
  const persistOrder = async (order: string[]) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('lead_assignment_queue')
      .upsert(order.map((user_id, i) => ({ user_id, position: i })), { onConflict: 'user_id' });
    if (error) toast.error('Falha ao salvar a ordem', { description: error.message });
  };

  const addToQueue = async (uid: string) => {
    const next = [...queue, uid];
    setQueue(next);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('lead_assignment_queue')
      .insert({ user_id: uid, position: next.length - 1 });
    if (error) {
      setQueue(queue);
      toast.error('Falha ao adicionar', { description: error.message });
    }
  };

  const removeFromQueue = async (uid: string) => {
    const next = queue.filter((u) => u !== uid);
    setQueue(next);
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('lead_assignment_queue')
      .delete()
      .eq('user_id', uid);
    if (error) {
      setQueue(queue);
      toast.error('Falha ao remover', { description: error.message });
      return;
    }
    // Renormaliza as positions dos restantes.
    void persistOrder(next);
  };

  const onDrop = (targetIdx: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === targetIdx) return;
    const next = [...queue];
    const [moved] = next.splice(from, 1);
    next.splice(targetIdx, 0, moved);
    setQueue(next);
    void persistOrder(next);
  };

  if (!isAdmin) {
    return (
      <Card>
        <h2 className="text-xl font-bold text-display">Distribuição automática de leads</h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Apenas o owner desta instância pode configurar a fila de atribuição.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Distribuição automática de leads</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            No handoff (IA pausada), o próximo da fila vira responsável pela conversa — em sequência.
            Só atribui quando a conversa está sem responsável.
          </p>
        </header>

        <label className="flex items-center gap-3 rounded-lg border border-[rgba(var(--accent-rgb),0.15)] bg-[rgba(var(--surface-rgb),0.02)] px-4 py-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void toggleEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent-primary)]"
          />
          <span className="text-sm font-medium text-[var(--color-text-primary)]">
            Ativar atribuição automática
          </span>
        </label>

        {loading ? (
          <div className="text-sm text-[var(--color-text-secondary)] opacity-60">Carregando...</div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="text-label">Fila de atribuição</div>
              {queue.length === 0 ? (
                <p className="text-sm text-[var(--color-text-secondary)] opacity-70">
                  Nenhum membro na fila. Adicione abaixo para começar a distribuir.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {queue.map((uid, i) => (
                    <li
                      key={uid}
                      draggable
                      onDragStart={() => { dragIdx.current = i; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(i)}
                      className="flex items-center gap-2 rounded-lg border border-[rgba(var(--accent-rgb),0.15)] bg-[rgba(var(--surface-rgb),0.02)] px-3 py-2"
                    >
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-[var(--color-text-secondary)]" />
                      <span className="w-5 text-xs font-semibold text-[var(--accent-primary)]">{i + 1}</span>
                      <span className="flex-1 truncate text-sm text-[var(--color-text-primary)]">{emailOf(uid)}</span>
                      <button
                        type="button"
                        onClick={() => void removeFromQueue(uid)}
                        aria-label={`Remover ${emailOf(uid)} da fila`}
                        className="text-[var(--color-text-secondary)] opacity-70 transition hover:opacity-100 hover:text-[var(--color-error)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {queue.length > 1 && (
                <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
                  Arraste pela alça para reordenar a sequência.
                </p>
              )}
            </div>

            {available.length > 0 && (
              <div className="space-y-2">
                <div className="text-label">Fora da fila</div>
                <ul className="space-y-1.5">
                  {available.map((op) => (
                    <li
                      key={op.user_id}
                      className="flex items-center gap-2 rounded-lg border border-transparent bg-[rgba(var(--surface-rgb),0.015)] px-3 py-2"
                    >
                      <span className="flex-1 truncate text-sm text-[var(--color-text-secondary)]">
                        {op.email} {op.role === 'admin' ? '(admin)' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => void addToQueue(op.user_id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[rgba(var(--accent-rgb),0.2)] px-2.5 py-1 text-xs font-medium text-[var(--accent-secondary)] transition hover:border-[var(--accent-primary)] hover:bg-[rgba(var(--surface-rgb),0.05)]"
                      >
                        <Plus className="h-3 w-3" /> Adicionar
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
