-- Produtos: a chave unica ainda era global por nome (products_name_key), sobra
-- de antes da multi-tenancy. Duas organizacoes nao conseguiam ter um produto
-- com o mesmo nome, e um upsert por nome podia enxergar a linha da outra org.
-- Passa a ser unica por (org_id, name), como tags e contatos.
ALTER TABLE whatsapp_hub.products
  DROP CONSTRAINT IF EXISTS products_name_key;
DROP INDEX IF EXISTS whatsapp_hub.products_name_key;
ALTER TABLE whatsapp_hub.products
  ADD CONSTRAINT products_org_name_key UNIQUE (org_id, name);
