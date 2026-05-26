-- =============================================================
-- Seed Inicial - Dubob Acai e Milkshake
-- Cardapio + usuarios base
-- Uso: rodar no DBeaver conectado ao banco da Dubob
-- Requisito: extensao pgcrypto ativa
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

INSERT INTO "User" (id, name, email, "passwordHash", role, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Administrador', 'admin@dubob.com', crypt('Admin123!', gen_salt('bf', 10)), 'ADMIN', NOW(), NOW()),
  (gen_random_uuid()::text, 'Funcionario', 'funcionario@dubob.com', crypt('Admin123!', gen_salt('bf', 10)), 'FUNCIONARIO', NOW(), NOW()),
  (gen_random_uuid()::text, 'Cozinha', 'cozinha@dubob.com', crypt('Admin123!', gen_salt('bf', 10)), 'COZINHA', NOW(), NOW()),
  (gen_random_uuid()::text, 'Motoboy', 'motoboy@dubob.com', crypt('Admin123!', gen_salt('bf', 10)), 'MOTOBOY', NOW(), NOW())
ON CONFLICT (email) DO NOTHING;

INSERT INTO "Product" (id, name, description, "imageUrl", category, stock, "isActive", "createdAt", "updatedAt")
VALUES
  ('db_acai_copo', 'Acai no Copo', 'Base para montar acai no copo. Tamanho, sabor e complementos vao nas observacoes do pedido.', '/cardapio2.png', 'Acai no Copo', 0, true, NOW(), NOW()),
  ('db_acai_tradicional', 'Acai Tradicional', 'Acai no copo com ate 4 complementos inclusos.', '/acai.png', 'Acai no Copo', 0, true, NOW(), NOW()),
  ('db_acai_chocolate', 'Acai Chocolate', 'Base de acai com sabor chocolate e complementos a escolha.', '/cardapio2.png', 'Acai no Copo', 0, true, NOW(), NOW()),
  ('db_acai_trufa_branca', 'Acai Trufa Branca', 'Acai cremoso com toque de trufa branca.', '/cardapio2.png', 'Acai no Copo', 0, true, NOW(), NOW()),
  ('db_acai_iogurte_grego', 'Acai Iogurte Grego', 'Acai com sabor iogurte grego e frutas selecionadas.', '/acai.png', 'Acai no Copo', 0, true, NOW(), NOW()),
  ('db_milkshake_tradicional', 'Milk Shake Tradicional', 'Base para milk shake tradicional. O sabor escolhido vai nas observacoes do pedido.', '/cardapio.png', 'Milkshakes', 0, true, NOW(), NOW()),
  ('db_milkshake_especial', 'Milk Shake Linha Especial', 'Base para milk shake da linha especial. O sabor escolhido vai nas observacoes do pedido.', '/cardapio.png', 'Linha Especial', 0, true, NOW(), NOW()),
  ('db_milkshake_alcoolico', 'Milk Shake Linha Alcoolica', 'Base para milk shake da linha alcoolica. O sabor escolhido vai nas observacoes do pedido.', '/cardapio.png', 'Linha Alcoolica', 0, true, NOW(), NOW()),
  ('db_milkshake_premium', 'Milk Shake Linha Premium', 'Base para milk shake da linha premium. O sabor escolhido vai nas observacoes do pedido.', '/cardapio.png', 'Linha Premium', 0, true, NOW(), NOW()),
  ('db_milkshake_acai', 'Milkshake de Acai', 'Milkshake cremoso sabor acai.', '/cardapio.png', 'Milkshakes', 0, true, NOW(), NOW()),
  ('db_milkshake_morango', 'Milkshake de Morango', 'Milkshake gelado de morango.', '/cardapio.png', 'Milkshakes', 0, true, NOW(), NOW()),
  ('db_milkshake_ninho', 'Milkshake Leite Ninho', 'Linha especial com leite Ninho.', '/cardapio.png', 'Linha Especial', 0, true, NOW(), NOW()),
  ('db_milkshake_ovomaltine', 'Milkshake Ovomaltine', 'Linha especial com Ovomaltine crocante.', '/cardapio.png', 'Linha Especial', 0, true, NOW(), NOW()),
  ('db_milkshake_nutella', 'Milkshake Nutella', 'Linha premium feito com Nutella original.', '/cardapio.png', 'Linha Premium', 0, true, NOW(), NOW()),
  ('db_milkshake_kitkat', 'Milkshake Kit Kat', 'Linha premium com Kit Kat.', '/cardapio.png', 'Linha Premium', 0, true, NOW(), NOW()),
  ('db_adicional_ninho', 'Adicional Leite Ninho', 'Turbine seu acai ou milkshake.', NULL, 'Complementos', 0, true, NOW(), NOW()),
  ('db_adicional_ovomaltine', 'Adicional Ovomaltine', 'Turbine seu acai ou milkshake.', NULL, 'Complementos', 0, true, NOW(), NOW()),
  ('db_adicional_pacoquinha', 'Adicional Pacoquinha', 'Turbine seu acai ou milkshake.', NULL, 'Complementos', 0, true, NOW(), NOW()),
  ('db_acai_extra_complementos', 'Adicional 4 complementos acai', 'Cobranca unica para escolher do 5 ao 8 complemento no acai.', NULL, 'Adicionais Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_sabor_tradicional', 'Tradicional', NULL, NULL, 'Sabor Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_sabor_chocolate', 'Chocolate', NULL, NULL, 'Sabor Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_sabor_trufa_branca', 'Trufa Branca', NULL, NULL, 'Sabor Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_sabor_iogurte_grego', 'Iogurte Grego', NULL, NULL, 'Sabor Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_morango', 'Morango', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_banana', 'Banana', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_kiwi', 'Kiwi', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_leite_condensado', 'Leite Condensado', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_leite_po', 'Leite em Po', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_ovomaltine', 'Ovomaltine', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_choco_wafer', 'Choco Wafer', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_ganache_branco', 'Ganache Branco', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_ganache_preto', 'Ganache Preto', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_mini_confete', 'Mini Confete', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_granulado', 'Granulado', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_granola', 'Granola', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_cookies_cream', 'Cookies Cream', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_wafer_branco', 'Wafer Branco', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_creme_amendoim', 'Creme de Amendoim', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_amendoim_triturado', 'Amendoim Triturado', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_creme_ninho', 'Creme de Leite Ninho', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_choco_wafer_branco', 'Choco Wafer Branco', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW()),
  ('db_cfg_acai_comp_chocolate_avela', 'Chocolate com Avela', NULL, NULL, 'Complementos Acai', 0, true, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ProductSize" (id, "productId", size, price, "costPrice", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'db_acai_copo', 'PEQUENA', 18.00, 7.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_copo', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_copo', 'GRANDE', 25.00, 10.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_copo', 'FAMILIA', 35.00, 14.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_tradicional', 'PEQUENA', 18.00, 7.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_tradicional', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_tradicional', 'GRANDE', 25.00, 10.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_tradicional', 'FAMILIA', 35.00, 14.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_chocolate', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_trufa_branca', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_iogurte_grego', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_tradicional', 'PEQUENA', 10.00, 4.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_tradicional', 'MEDIA', 13.00, 5.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_tradicional', 'GRANDE', 21.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_tradicional', 'FAMILIA', 22.00, 9.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_especial', 'PEQUENA', 13.00, 5.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_especial', 'MEDIA', 17.00, 6.50, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_especial', 'GRANDE', 21.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_especial', 'FAMILIA', 27.00, 10.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_alcoolico', 'PEQUENA', 13.00, 5.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_alcoolico', 'MEDIA', 17.00, 6.50, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_alcoolico', 'GRANDE', 21.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_alcoolico', 'FAMILIA', 27.00, 10.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_premium', 'PEQUENA', 16.00, 6.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_premium', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_premium', 'GRANDE', 25.00, 10.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_premium', 'FAMILIA', 30.00, 12.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_acai', 'PEQUENA', 10.00, 4.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_acai', 'MEDIA', 13.00, 5.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_acai', 'GRANDE', 21.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_acai', 'FAMILIA', 22.00, 9.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_morango', 'MEDIA', 13.00, 5.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_ninho', 'MEDIA', 17.00, 6.50, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_ovomaltine', 'MEDIA', 17.00, 6.50, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_nutella', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_milkshake_kitkat', 'MEDIA', 20.00, 8.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_adicional_ninho', 'MEDIA', 3.00, 1.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_adicional_ovomaltine', 'MEDIA', 3.00, 1.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_adicional_pacoquinha', 'MEDIA', 3.00, 1.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_acai_extra_complementos', 'MEDIA', 5.00, 1.50, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_sabor_tradicional', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_sabor_chocolate', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_sabor_trufa_branca', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_sabor_iogurte_grego', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_morango', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_banana', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_kiwi', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_leite_condensado', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_leite_po', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_ovomaltine', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_choco_wafer', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_ganache_branco', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_ganache_preto', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_mini_confete', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_granulado', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_granola', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_cookies_cream', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_wafer_branco', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_creme_amendoim', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_amendoim_triturado', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_creme_ninho', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_choco_wafer_branco', 'MEDIA', 1.00, 0.00, NOW(), NOW()),
  (gen_random_uuid()::text, 'db_cfg_acai_comp_chocolate_avela', 'MEDIA', 1.00, 0.00, NOW(), NOW())
ON CONFLICT ("productId", size) DO NOTHING;

UPDATE "ProductSize" SET "label" = 'P - 300 ml'
WHERE "productId" IN ('db_acai_copo', 'db_acai_tradicional', 'db_milkshake_tradicional', 'db_milkshake_acai') AND "size" = 'PEQUENA';
UPDATE "ProductSize" SET "label" = 'M - 400 ml'
WHERE "productId" IN ('db_acai_copo', 'db_acai_tradicional', 'db_milkshake_tradicional', 'db_milkshake_acai') AND "size" = 'MEDIA';
UPDATE "ProductSize" SET "label" = 'G - 500 ml'
WHERE "productId" IN ('db_acai_copo', 'db_acai_tradicional', 'db_milkshake_tradicional', 'db_milkshake_acai') AND "size" = 'GRANDE';
UPDATE "ProductSize" SET "label" = 'MG - 700 ml'
WHERE "productId" IN ('db_acai_copo', 'db_acai_tradicional', 'db_milkshake_tradicional', 'db_milkshake_acai') AND "size" = 'FAMILIA';

UPDATE "ProductSize" SET "label" = 'P - 300 ml'
WHERE "productId" IN ('db_milkshake_especial', 'db_milkshake_alcoolico', 'db_milkshake_premium') AND "size" = 'PEQUENA';
UPDATE "ProductSize" SET "label" = 'M - 400 ml'
WHERE "productId" IN ('db_milkshake_especial', 'db_milkshake_alcoolico', 'db_milkshake_premium') AND "size" = 'MEDIA';
UPDATE "ProductSize" SET "label" = 'G - 500 ml'
WHERE "productId" IN ('db_milkshake_especial', 'db_milkshake_alcoolico', 'db_milkshake_premium') AND "size" = 'GRANDE';
UPDATE "ProductSize" SET "label" = 'MG - 700 ml'
WHERE "productId" IN ('db_milkshake_especial', 'db_milkshake_alcoolico', 'db_milkshake_premium') AND "size" = 'FAMILIA';
