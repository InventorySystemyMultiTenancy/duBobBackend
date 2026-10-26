import crypto from "crypto";
import { prisma } from "../lib/prisma.js";

// Promoções: preço especial de um produto (e tamanho) por tempo limitado.
// Tabela criada aqui, como o AppSetting.
let tableReady = null;

function ensureTable() {
  tableReady ??= (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Promotion" (
        "id" TEXT PRIMARY KEY,
        "title" TEXT NOT NULL,
        "productId" TEXT NOT NULL,
        "size" TEXT,
        "price" NUMERIC(10, 2) NOT NULL,
        "startsAt" TIMESTAMP(3) NOT NULL,
        "endsAt" TIMESTAMP(3) NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Promotion_productId_endsAt_idx"
      ON "Promotion" ("productId", "endsAt")
    `);
  })().catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

const toPromotion = (row) => ({
  ...row,
  price: Number(row.price),
});

export class PromotionRepository {
  async ensureTable() {
    await ensureTable();
  }

  async list() {
    await ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT pr.*, p.name AS "productName", p.category AS "productCategory"
      FROM "Promotion" pr
      LEFT JOIN "Product" p ON p.id = pr."productId"
      ORDER BY pr."endsAt" DESC
    `;
    return rows.map(toPromotion);
  }

  // Valendo agora (ativas e dentro do horário)
  async listActive(now = new Date()) {
    await ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT pr.*, p.name AS "productName"
      FROM "Promotion" pr
      LEFT JOIN "Product" p ON p.id = pr."productId"
      WHERE pr."isActive" = true AND pr."startsAt" <= ${now} AND pr."endsAt" > ${now}
      ORDER BY pr."endsAt" ASC
    `;
    return rows.map(toPromotion);
  }

  async create({ title, productId, size, price, startsAt, endsAt, isActive = true }) {
    await ensureTable();
    const rows = await prisma.$queryRaw`
      INSERT INTO "Promotion" ("id", "title", "productId", "size", "price", "startsAt", "endsAt", "isActive")
      VALUES (${crypto.randomUUID()}, ${title}, ${productId}, ${size ?? null}, ${price},
              ${startsAt}, ${endsAt}, ${isActive})
      RETURNING *
    `;
    return toPromotion(rows[0]);
  }

  async update(id, { title, productId, size, price, startsAt, endsAt, isActive }) {
    await ensureTable();
    const rows = await prisma.$queryRaw`
      UPDATE "Promotion" SET
        "title" = ${title}, "productId" = ${productId}, "size" = ${size ?? null},
        "price" = ${price}, "startsAt" = ${startsAt}, "endsAt" = ${endsAt},
        "isActive" = ${isActive}, "updatedAt" = NOW()
      WHERE "id" = ${id}
      RETURNING *
    `;
    return rows[0] ? toPromotion(rows[0]) : null;
  }

  async remove(id) {
    await ensureTable();
    return prisma.$executeRaw`DELETE FROM "Promotion" WHERE "id" = ${id}`;
  }
}

// Preço promocional valendo agora para o produto/tamanho (ou null).
// Usa o client da transação do pedido; se a tabela ainda não existir,
// simplesmente não há promoção.
export async function findPromoPrice(client, productId, size, now = new Date()) {
  if (typeof client?.$queryRaw !== "function") return null;
  try {
    const rows = await client.$queryRaw`
      SELECT "price" FROM "Promotion"
      WHERE "productId" = ${productId}
        AND ("size" IS NULL OR "size" = ${size ?? null})
        AND "isActive" = true AND "startsAt" <= ${now} AND "endsAt" > ${now}
      ORDER BY "price" ASC
      LIMIT 1
    `;
    return rows[0] ? Number(rows[0].price) : null;
  } catch {
    return null;
  }
}
