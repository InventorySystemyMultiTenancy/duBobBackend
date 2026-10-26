import crypto from "crypto";
import { prisma } from "../lib/prisma.js";

// Fila dos avisos de WhatsApp do delivery e lista de quem pediu para sair.
// Tabelas criadas aqui (mesmo padrão do AppSetting), fora do schema.prisma.
let tablesReady = null;

function ensureTables() {
  tablesReady ??= (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WhatsappMessage" (
        "id" TEXT PRIMARY KEY,
        "orderId" TEXT NOT NULL,
        "etapa" TEXT NOT NULL,
        "telefone" TEXT NOT NULL,
        "texto" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'FILA',
        "tentativas" INTEGER NOT NULL DEFAULT 0,
        "erro" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "enviadoEm" TIMESTAMP(3)
      )
    `);
    // Um aviso por pedido e etapa: clicar duas vezes não repete a mensagem
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappMessage_orderId_etapa_key"
      ON "WhatsappMessage" ("orderId", "etapa")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "WhatsappMessage_status_createdAt_idx"
      ON "WhatsappMessage" ("status", "createdAt")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WhatsappOptOut" (
        "telefone" TEXT PRIMARY KEY,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Quem aceitou receber promoções no WhatsApp (cadastro ou checkout)
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "whatsappPromo" BOOLEAN NOT NULL DEFAULT false`,
    );
    // Campanhas de promoção: cada destinatário vira uma mensagem na fila
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WhatsappCampaign" (
        "id" TEXT PRIMARY KEY,
        "titulo" TEXT NOT NULL,
        "mensagens" TEXT NOT NULL,
        "intervaloSegundos" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ENVIANDO',
        "total" INTEGER NOT NULL DEFAULT 0,
        "criadoPor" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "WhatsappCampaignMessage" (
        "id" TEXT PRIMARY KEY,
        "campaignId" TEXT NOT NULL,
        "telefone" TEXT NOT NULL,
        "nome" TEXT,
        "texto" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'FILA',
        "erro" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "enviadoEm" TIMESTAMP(3)
      )
    `);
    // Um envio por número em cada campanha
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappCampaignMessage_campaign_telefone_key"
      ON "WhatsappCampaignMessage" ("campaignId", "telefone")
    `);
  })().catch((error) => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

export class WhatsappRepository {
  async ensureTables() {
    await ensureTables();
  }

  // Devolve false quando o aviso desse pedido/etapa já existia
  async enqueue({ orderId, etapa, telefone, texto }) {
    await ensureTables();
    const rows = await prisma.$queryRaw`
      INSERT INTO "WhatsappMessage" ("id", "orderId", "etapa", "telefone", "texto")
      VALUES (${crypto.randomUUID()}, ${orderId}, ${etapa}, ${telefone}, ${texto})
      ON CONFLICT ("orderId", "etapa") DO NOTHING
      RETURNING "id"
    `;
    return rows.length > 0;
  }

  async nextInQueue() {
    await ensureTables();
    const rows = await prisma.$queryRaw`
      SELECT * FROM "WhatsappMessage"
      WHERE "status" = 'FILA'
      ORDER BY "createdAt" ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // Reserva a mensagem para envio (só se ainda estiver na fila)
  async reserve(id) {
    const count = await prisma.$executeRaw`
      UPDATE "WhatsappMessage" SET "status" = 'ENVIANDO', "tentativas" = "tentativas" + 1
      WHERE "id" = ${id} AND "status" = 'FILA'
    `;
    return count > 0;
  }

  async markSent(id) {
    await prisma.$executeRaw`
      UPDATE "WhatsappMessage" SET "status" = 'ENVIADO', "enviadoEm" = NOW(), "erro" = NULL
      WHERE "id" = ${id}
    `;
  }

  async markFailed(id, erro, { retry }) {
    const status = retry ? "FILA" : "ERRO";
    await prisma.$executeRaw`
      UPDATE "WhatsappMessage" SET "status" = ${status}, "erro" = ${String(erro).slice(0, 500)}
      WHERE "id" = ${id}
    `;
  }

  async markDiscarded(id, motivo) {
    await prisma.$executeRaw`
      UPDATE "WhatsappMessage" SET "status" = 'DESCARTADA', "erro" = ${motivo}
      WHERE "id" = ${id}
    `;
  }

  // Ao subir o servidor, o que ficou "enviando" volta para a fila
  async requeueSending() {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `UPDATE "WhatsappMessage" SET "status" = 'FILA' WHERE "status" = 'ENVIANDO'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "WhatsappCampaignMessage" SET "status" = 'FILA' WHERE "status" = 'ENVIANDO'`,
    );
  }

  async queueSummary() {
    await ensureTables();
    const [counts] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'FILA')::int AS "naFila",
        COUNT(*) FILTER (WHERE "status" = 'ENVIADO' AND "enviadoEm" > NOW() - INTERVAL '1 day')::int AS "enviadasHoje",
        COUNT(*) FILTER (WHERE "status" = 'ERRO' AND "createdAt" > NOW() - INTERVAL '1 day')::int AS "errosHoje"
      FROM "WhatsappMessage"
    `;
    const recentes = await prisma.$queryRaw`
      SELECT "id", "orderId", "etapa", "telefone", "status", "erro", "createdAt", "enviadoEm"
      FROM "WhatsappMessage"
      ORDER BY "createdAt" DESC
      LIMIT 20
    `;
    return { ...counts, recentes };
  }

  async isOptedOut(telefone) {
    await ensureTables();
    const rows = await prisma.$queryRaw`
      SELECT 1 FROM "WhatsappOptOut" WHERE "telefone" = ${telefone} LIMIT 1
    `;
    return rows.length > 0;
  }

  async optOut(telefone) {
    await ensureTables();
    await prisma.$executeRaw`
      INSERT INTO "WhatsappOptOut" ("telefone") VALUES (${telefone})
      ON CONFLICT ("telefone") DO NOTHING
    `;
  }

  async optOutList() {
    await ensureTables();
    const rows = await prisma.$queryRaw`SELECT "telefone" FROM "WhatsappOptOut"`;
    return new Set(rows.map((row) => row.telefone));
  }

  async setPromoOptIn(userId, aceita) {
    await ensureTables();
    await prisma.$executeRaw`
      UPDATE "User" SET "whatsappPromo" = ${Boolean(aceita)} WHERE "id" = ${userId}
    `;
  }

  async getPromoOptIn(userId) {
    await ensureTables();
    const rows = await prisma.$queryRaw`
      SELECT "whatsappPromo" FROM "User" WHERE "id" = ${userId}
    `;
    return Boolean(rows[0]?.whatsappPromo);
  }

  // Clientes que aceitaram promoções, com o celular do cadastro ou o último
  // celular informado num pedido de entrega
  async promoAudience() {
    await ensureTables();
    return prisma.$queryRaw`
      SELECT u.id, u.name,
             COALESCE(NULLIF(u.phone, ''), (
               SELECT o."contactPhone" FROM "Order" o
               WHERE o."userId" = u.id AND o."contactPhone" IS NOT NULL
               ORDER BY o."createdAt" DESC LIMIT 1
             )) AS telefone
      FROM "User" u
      WHERE u."whatsappPromo" = true AND u.role::text = 'CLIENTE'
    `;
  }

  async createCampaign({ titulo, mensagens, intervaloSegundos, criadoPor, destinatarios }) {
    await ensureTables();
    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "WhatsappCampaign" ("id", "titulo", "mensagens", "intervaloSegundos", "total", "criadoPor")
      VALUES (${id}, ${titulo}, ${JSON.stringify(mensagens)}, ${intervaloSegundos},
              ${destinatarios.length}, ${criadoPor ?? null})
    `;
    for (const d of destinatarios) {
      await prisma.$executeRaw`
        INSERT INTO "WhatsappCampaignMessage" ("id", "campaignId", "telefone", "nome", "texto")
        VALUES (${crypto.randomUUID()}, ${id}, ${d.telefone}, ${d.nome ?? null}, ${d.texto})
        ON CONFLICT ("campaignId", "telefone") DO NOTHING
      `;
    }
    return id;
  }

  async listCampaigns() {
    await ensureTables();
    return prisma.$queryRaw`
      SELECT c."id", c."titulo", c."intervaloSegundos", c."status", c."total", c."createdAt",
             COUNT(m.*) FILTER (WHERE m."status" = 'ENVIADO')::int AS "enviadas",
             COUNT(m.*) FILTER (WHERE m."status" = 'ERRO')::int AS "erros",
             COUNT(m.*) FILTER (WHERE m."status" = 'FILA')::int AS "naFila"
      FROM "WhatsappCampaign" c
      LEFT JOIN "WhatsappCampaignMessage" m ON m."campaignId" = c."id"
      GROUP BY c."id"
      ORDER BY c."createdAt" DESC
      LIMIT 20
    `;
  }

  async nextCampaignMessage() {
    await ensureTables();
    const rows = await prisma.$queryRaw`
      SELECT m.*, c."intervaloSegundos"
      FROM "WhatsappCampaignMessage" m
      JOIN "WhatsappCampaign" c ON c."id" = m."campaignId"
      WHERE m."status" = 'FILA' AND c."status" = 'ENVIANDO'
      ORDER BY c."createdAt" ASC, m."createdAt" ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async reserveCampaignMessage(id) {
    const count = await prisma.$executeRaw`
      UPDATE "WhatsappCampaignMessage" SET "status" = 'ENVIANDO'
      WHERE "id" = ${id} AND "status" = 'FILA'
    `;
    return count > 0;
  }

  async finishCampaignMessage(id, erro = null) {
    if (erro) {
      await prisma.$executeRaw`
        UPDATE "WhatsappCampaignMessage" SET "status" = 'ERRO', "erro" = ${String(erro).slice(0, 500)}
        WHERE "id" = ${id}
      `;
    } else {
      await prisma.$executeRaw`
        UPDATE "WhatsappCampaignMessage" SET "status" = 'ENVIADO', "enviadoEm" = NOW()
        WHERE "id" = ${id}
      `;
    }
  }

  // Campanha sem mais nada na fila vira concluída
  async closeFinishedCampaigns() {
    await prisma.$executeRawUnsafe(`
      UPDATE "WhatsappCampaign" c SET "status" = 'CONCLUIDA'
      WHERE c."status" = 'ENVIANDO' AND NOT EXISTS (
        SELECT 1 FROM "WhatsappCampaignMessage" m
        WHERE m."campaignId" = c."id" AND m."status" IN ('FILA', 'ENVIANDO')
      )
    `);
  }

  async cancelCampaign(id) {
    await ensureTables();
    await prisma.$executeRaw`
      UPDATE "WhatsappCampaignMessage" SET "status" = 'CANCELADA'
      WHERE "campaignId" = ${id} AND "status" = 'FILA'
    `;
    await prisma.$executeRaw`
      UPDATE "WhatsappCampaign" SET "status" = 'CANCELADA'
      WHERE "id" = ${id} AND "status" = 'ENVIANDO'
    `;
  }

  // Dados do pedido para decidir e montar o aviso
  async findOrderForNotice(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT o.id, o.status::text AS status, o."paymentStatus"::text AS "paymentStatus",
             o."paymentMethod", o."isPickup", o."mesaId", o."comandaId",
             o."deliveryCode", o."contactPhone",
             u.name AS "userName", u.phone AS "userPhone",
             m.name AS "motoboyName"
      FROM "Order" o
      LEFT JOIN "User" u ON u.id = o."userId"
      LEFT JOIN "User" m ON m.id = o."assignedMotoboyId"
      WHERE o.id = ${orderId}
    `;
    return rows[0] ?? null;
  }
}
