import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Forecast = pipeline em aberto ponderado pela probabilidade de cada estágio:
//   Σ (deal.value × stage.probability / 100)  para deals status = 'open'.
// Também devolve o recorte "fechamentos previstos para o mês atual" (deals com
// expected_close dentro do mês vigente), para deixar o escopo explícito no card.
export interface ForecastData {
  value: number;        // pipeline aberto ponderado (todo o pipeline, sem filtro de mês)
  openCount: number;    // qtd de negócios abertos
  monthValue: number;   // ponderado, só com expected_close no mês atual
  monthCount: number;
  loading: boolean;
  error: string | null;
}

interface DealRow {
  value: number | null;
  expected_close: string | null;
  stage: { probability: number | null } | null;
}

function monthBounds(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export function useForecast(): ForecastData {
  const [data, setData] = useState<ForecastData>({
    value: 0, openCount: 0, monthValue: 0, monthCount: 0, loading: true, error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabase();
        const { data: rows, error } = await supabase
          .from('deals')
          .select('value, expected_close, stage:stage_id(probability)')
          .eq('status', 'open');
        if (error) throw new Error(error.message);

        const { start, end } = monthBounds(new Date());
        let value = 0, openCount = 0, monthValue = 0, monthCount = 0;
        for (const d of (rows ?? []) as unknown as DealRow[]) {
          openCount++;
          const prob = Number(d.stage?.probability ?? 0) / 100;
          const weighted = (Number(d.value) || 0) * prob;
          value += weighted;
          if (d.expected_close && d.expected_close >= start && d.expected_close <= end) {
            monthValue += weighted;
            monthCount++;
          }
        }
        if (!cancelled) {
          setData({ value: Math.round(value), openCount, monthValue: Math.round(monthValue), monthCount, loading: false, error: null });
        }
      } catch (e) {
        if (!cancelled) {
          setData({ value: 0, openCount: 0, monthValue: 0, monthCount: 0, loading: false, error: e instanceof Error ? e.message : 'Erro ao carregar forecast' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return data;
}
