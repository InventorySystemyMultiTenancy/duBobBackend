import dotenv from "dotenv";
import http from "http";
import { app } from "./app.js";
import { initializeSocketServer, onOrderEvent } from "./realtime/socketServer.js";
import { prisma } from "./lib/prisma.js";
import { whatsappService } from "./services/WhatsappService.js";
import { ifoodService } from "./services/IfoodService.js";

dotenv.config();

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const port = Number(process.env.PORT || 3000);
const server = http.createServer(app);

initializeSocketServer(server);

// Auto-migrate new columns so the server never fails due to missing columns
async function runMigrations() {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS "Comanda" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "number" INTEGER NOT NULL, "accessToken" TEXT NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Comanda_pkey" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Comanda_number_key" ON "Comanda"("number")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Comanda_accessToken_key" ON "Comanda"("accessToken")`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "comandaId" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "isPickup" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "assignedMotoboyId" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryCode" TEXT`,
    // Celular do pedido de entrega, para os avisos de WhatsApp
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT`,
    // Número de exibição do pedido: 1 a 1000 e volta ao 1 (o id continua único)
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "number" INTEGER`,
    `CREATE SEQUENCE IF NOT EXISTS "OrderNumber_seq" MINVALUE 1 MAXVALUE 1000 CYCLE`,
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
    `ALTER TABLE "ProductSize" ADD COLUMN IF NOT EXISTS "label" TEXT`,
    // Adicional do açaí (do 5º ao 8º complemento) cobrado dentro do mesmo item.
    `INSERT INTO "Addon" ("id", "name", "price", "isActive", "createdAt", "updatedAt")
      VALUES ('db_addon_acai_extra_complementos', '4 complementos extras', 5.00, true, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
    // Complementos do milk shake (R$ 3,00 cada, preço editável no admin).
    `INSERT INTO "Product" ("id", "name", "category", "isActive", "createdAt", "updatedAt")
      VALUES
        ('db_mscomp_leite_ninho', 'Leite Ninho', 'complemento milkshake', true, NOW(), NOW()),
        ('db_mscomp_ovomaltine', 'Ovomaltine', 'complemento milkshake', true, NOW(), NOW()),
        ('db_mscomp_pacoquinha', 'Paçoquinha', 'complemento milkshake', true, NOW(), NOW()),
        ('db_mscomp_leite_condensado', 'Leite Condensado', 'complemento milkshake', true, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "ProductSize" ("id", "productId", "size", "label", "price", "createdAt", "updatedAt")
      SELECT 'size_' || p."id", p."id", 'PEQUENA', 'Adicional', 3.00, NOW(), NOW()
      FROM "Product" p
      WHERE p."id" IN ('db_mscomp_leite_ninho', 'db_mscomp_ovomaltine', 'db_mscomp_pacoquinha', 'db_mscomp_leite_condensado')
      ON CONFLICT ("productId", "size") DO NOTHING`,
    // Complementos "Sugestão" do açaí (aparecem antes dos outros): já cadastrados DESLIGADOS e
    // sem preço; o dono define o preço e ativa no admin quando quiser.
    `INSERT INTO "Product" ("id", "name", "category", "isActive", "createdAt", "updatedAt")
      VALUES
        ('db_sug_nutella', 'Nutella', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_kit_kat', 'Kit Kat', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_bis', 'Bis', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_sonho_de_valsa', 'Sonho de Valsa', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_ouro_branco', 'Ouro Branco', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_pacoca', 'Paçoca', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_leite_ninho', 'Leite Ninho', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_kinder_bueno', 'Kinder Bueno', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_ferrero_rocher', 'Ferrero Rocher', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_oreo', 'Oreo', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_prestigio', 'Prestígio', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_mms', 'M&M''s', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_marshmallow', 'Marshmallow', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_gotas_chocolate', 'Gotas de Chocolate', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_doce_de_leite', 'Doce de Leite', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_mel', 'Mel', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_chantilly', 'Chantilly', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_coco_ralado', 'Coco Ralado', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_manga', 'Manga', 'complemento acai sugestao', false, NOW(), NOW()),
        ('db_sug_uva', 'Uva', 'complemento acai sugestao', false, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "ProductSize" ("id", "productId", "size", "label", "price", "createdAt", "updatedAt")
      SELECT 'size_' || p."id", p."id", 'PEQUENA', 'Adicional', 0, NOW(), NOW()
      FROM "Product" p
      WHERE p."id" LIKE 'db_sug_%'
      ON CONFLICT ("productId", "size") DO NOTHING`,
    // Pedidos que vêm de fora (iFood): origem, id lá fora e dados da entrega
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "externalSource" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "externalId" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "externalDisplayId" TEXT`,
    `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "externalPayload" JSONB`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Order_externalSource_externalId_key" ON "Order"("externalSource", "externalId")`,
    // Dono dos pedidos do iFood (sem e-mail/telefone: não faz login) e o item
    // usado quando o produto do iFood não tem par no cardápio
    `INSERT INTO "User" ("id", "name", "passwordHash", "role", "createdAt", "updatedAt")
      VALUES ('db_user_ifood', 'iFood', '!', 'CLIENTE', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "Product" ("id", "name", "category", "isActive", "createdAt", "updatedAt")
      VALUES ('db_ifood_item', 'Item iFood', 'ifood', false, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
    `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'TV'
            AND enumtypid = '"Role"'::regtype
        ) THEN
          ALTER TYPE "Role" ADD VALUE 'TV';
        END IF;
      END $$`,
  ];
  for (const sql of migrations) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error("[migration] falhou:", sql, err.message);
    }
  }
  console.log("[migration] colunas verificadas/criadas com sucesso");
}

runMigrations().then(() => {
  // Avisos de WhatsApp do delivery (só envia se estiver ligado no admin)
  onOrderEvent((type, payload) => whatsappService.onOrderEvent(type, payload));
  whatsappService.iniciar();
  // Pedidos do iFood (só consulta se estiver ligado no admin)
  onOrderEvent((type, payload) => ifoodService.onOrderEvent(type, payload));
  ifoodService.iniciar();
  server.listen(port, () => {
    console.log(`API Dubob rodando na porta ${port}`);
  });
});
