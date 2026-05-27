import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma.js";

function mapTotem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    slug: row.slug,
    terminalId: row.terminalId,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TotemRepository {
  async ensureTable() {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "Totem" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "number" INTEGER NOT NULL,
        "slug" TEXT NOT NULL,
        "terminalId" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Totem_pkey" PRIMARY KEY ("id")
      )
    `;
    await prisma.$executeRaw`
      CREATE UNIQUE INDEX IF NOT EXISTS "Totem_number_key" ON "Totem"("number")
    `;
    await prisma.$executeRaw`
      CREATE UNIQUE INDEX IF NOT EXISTS "Totem_slug_key" ON "Totem"("slug")
    `;
  }

  async create({ name, number, slug, terminalId }) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      INSERT INTO "Totem" ("id", "name", "number", "slug", "terminalId", "updatedAt")
      VALUES (${randomUUID()}, ${name}, ${number}, ${slug}, ${terminalId}, NOW())
      RETURNING *
    `;
    return mapTotem(rows[0]);
  }

  async findAll() {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT * FROM "Totem" ORDER BY "number" ASC
    `;
    return rows.map(mapTotem);
  }

  async findById(id) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT * FROM "Totem" WHERE "id" = ${id} LIMIT 1
    `;
    return mapTotem(rows[0]);
  }

  async findBySlug(slug) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT * FROM "Totem" WHERE "slug" = ${slug} LIMIT 1
    `;
    return mapTotem(rows[0]);
  }

  async update(id, data) {
    await this.ensureTable();
    const current = await this.findById(id);
    if (!current) return null;

    const next = {
      name: data.name ?? current.name,
      number: data.number ?? current.number,
      slug: data.slug ?? current.slug,
      terminalId:
        Object.prototype.hasOwnProperty.call(data, "terminalId")
          ? data.terminalId
          : current.terminalId,
      isActive:
        Object.prototype.hasOwnProperty.call(data, "isActive")
          ? data.isActive
          : current.isActive,
    };

    const rows = await prisma.$queryRaw`
      UPDATE "Totem"
      SET
        "name" = ${next.name},
        "number" = ${next.number},
        "slug" = ${next.slug},
        "terminalId" = ${next.terminalId},
        "isActive" = ${next.isActive},
        "updatedAt" = NOW()
      WHERE "id" = ${id}
      RETURNING *
    `;
    return mapTotem(rows[0]);
  }

  async delete(id) {
    await this.ensureTable();
    await prisma.$executeRaw`
      DELETE FROM "Totem" WHERE "id" = ${id}
    `;
  }
}
