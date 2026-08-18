-- A tela de Produtos tem o campo Descricao e o hook seleciona a coluna, mas
-- nenhuma migration a criou: o catalogo inteiro falhava ao carregar
-- ("column products.description does not exist").
ALTER TABLE whatsapp_hub.products
  ADD COLUMN IF NOT EXISTS description TEXT;
