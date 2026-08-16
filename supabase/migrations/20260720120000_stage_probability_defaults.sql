-- ============================================================================
-- Forecast · probabilidades de estágio com defaults sensatos
-- ----------------------------------------------------------------------------
-- stages.probability nasceu com DEFAULT 0 (migration 20260713140000), então os
-- estágios existentes ficaram todos em 0 → forecast = Σ(valor × 0) = 0.
-- Aqui: (1) muda o default para 50 (novos estágios abertos passam a ter peso);
-- (2) faz backfill dos estágios que AINDA estão em 0, sem sobrescrever valores
-- já configurados pelo usuário: ganho=100, perdido=0, abertos graduados por
-- posição (10..90).
-- ============================================================================

SET search_path TO whatsapp_hub, public;

ALTER TABLE whatsapp_hub.stages ALTER COLUMN probability SET DEFAULT 50;

-- Ganho → 100 (só onde ainda está no default 0).
UPDATE whatsapp_hub.stages SET probability = 100 WHERE is_won AND probability = 0;

-- Abertos → graduados por posição relativa dentro do pipeline (10..90).
WITH open_stages AS (
  SELECT id,
         row_number() OVER (PARTITION BY pipeline_id ORDER BY position) AS rn,
         count(*)     OVER (PARTITION BY pipeline_id)                   AS total
  FROM whatsapp_hub.stages
  WHERE NOT is_won AND NOT is_lost
)
UPDATE whatsapp_hub.stages s
SET probability = GREATEST(10, LEAST(90, round((os.rn::numeric / GREATEST(os.total, 1)) * 90)))
FROM open_stages os
WHERE s.id = os.id AND s.probability = 0;

-- Perdido permanece 0 (já é o default nesses estágios).
