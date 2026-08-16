import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Negócios ABERTOS de um contato — versão enxuta usada pelo seletor "Negócio
// ativo" da inbox (ContactPanel). Não reusa useContactProfile de propósito:
// aquele hook também carrega timeline/mensagens/atividades, peso desnecessário
// para um simples <select>.
export interface ContactDeal {
  id: string;
  title: string;
  status: string;
  stage_id: string | null;
}

interface UseContactDealsResult {
  deals: ContactDeal[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useContactDeals(contactId: string | null | undefined): UseContactDealsResult {
  const [deals, setDeals] = useState<ContactDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!contactId) {
      setDeals([]);
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .schema('whatsapp_hub')
      .from('deals')
      .select('id, title, status, stage_id')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (err) {
      setError(err.message);
      setDeals([]);
    } else {
      setDeals((data ?? []) as ContactDeal[]);
    }
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { deals, loading, error, reload };
}
