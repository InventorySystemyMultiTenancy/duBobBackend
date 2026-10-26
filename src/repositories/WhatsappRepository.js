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
