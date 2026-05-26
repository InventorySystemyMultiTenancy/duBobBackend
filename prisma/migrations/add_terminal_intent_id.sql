-- Migration: add_terminal_intent_id
-- Adiciona coluna para rastrear o payment intent da maquininha MP Point.
-- Isso permite encontrar o orderId quando o webhook chega com referência interna do MP (INSTORE-...).

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "terminalIntentId" TEXT;
