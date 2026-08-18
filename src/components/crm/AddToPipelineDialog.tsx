import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';

// "Adicionar ao pipeline": cria um NOVO negócio para o contato no pipeline e
// estágio escolhidos — para clientes que entram numa nova negociação. Sempre
// cria um card novo (é o propósito), mesmo que exista outro negócio aberto.
interface AddToPipelineDialogProps {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName?: string | null;
  contactPhone?: string | null;
  onDone?: () => void;
}

const selectCls =
  'w-full rounded-lg border border-[rgba(212,165,116,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)] [&>option]:bg-[#0A0A0F]';

export function AddToPipelineDialog({
  open,
  onClose,
  contactId,
  contactName,
  contactPhone,
  onDone,
}: AddToPipelineDialogProps) {
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [stages, setStages] = useState<{ id: string; name: string; pipeline_id: string }[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const supabase = getSupabase();
    void (async () => {
      const [p, st] = await Promise.all([
        supabase.from('pipelines').select('id, name').order('position'),
        supabase.from('stages').select('id, name, pipeline_id').order('position'),
      ]);
      const ps = (p.data ?? []) as { id: string; name: string }[];
      setPipelines(ps);
      setStages((st.data ?? []) as { id: string; name: string; pipeline_id: string }[]);
      if (ps.length) setPipelineId((prev) => prev || ps[0].id);
    })();
  }, [open]);

  const pipelineStages = useMemo(
    () => stages.filter((s) => s.pipeline_id === pipelineId),
    [stages, pipelineId],
  );
  useEffect(() => {
    if (pipelineStages.length && !pipelineStages.some((s) => s.id === stageId)) {
      setStageId(pipelineStages[0].id);
    }
  }, [pipelineStages, stageId]);

  const create = async () => {
    if (!pipelineId || !stageId) {
      toast.error('Selecione o funil e a etapa.');
      return;
    }
    setSaving(true);
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('deals').insert({
        contact_id: contactId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: contactName || contactPhone || 'Nova oportunidade',
        status: 'open',
      });
      if (error) throw new Error(error.message);
      toast.success('Oportunidade aberta.');
      onDone?.();
      onClose();
    } catch (err) {
      toast.error('Falha ao abrir a oportunidade', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Abrir oportunidade">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Abre uma nova oportunidade para{' '}
          <b className="text-[var(--color-text-primary)]">{contactName || contactPhone || 'o contato'}</b>{' '}
          no funil e na etapa escolhidos.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
            Funil
            <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={selectCls}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
            Etapa
            <select value={stageId} onChange={(e) => setStageId(e.target.value)} className={selectCls}>
              {pipelineStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void create()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Adicionar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
