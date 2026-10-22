import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma.js";

// Maquininhas SumUp: cada uma tem um usuário gerenciado próprio na conta
// SumUp, usado para saber de qual maquininha veio cada venda. O readerId
// (opcional) é o reader pareado na Cloud API, para enviar a cobrança a ela.
export class SumUpOperatorRepository {
  async ensureTable() {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "SumUpOperator" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "email" TEXT NOT NULL UNIQUE,
        "passwordEnc" TEXT NOT NULL,
        "memberId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await prisma.$executeRaw`
      ALTER TABLE "SumUpOperator" ADD COLUMN IF NOT EXISTS "readerId" TEXT
    `;
  }

  async findAll() {
    await this.ensureTable();
    return prisma.$queryRaw`
      SELECT "id", "name", "email", "memberId", "readerId", "createdAt"
      FROM "SumUpOperator" ORDER BY "createdAt" ASC
    `;
  }

  async findById(id) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT * FROM "SumUpOperator" WHERE "id" = ${id} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async create({ name, email, passwordEnc, memberId }) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      INSERT INTO "SumUpOperator" ("id", "name", "email", "passwordEnc", "memberId")
      VALUES (${randomUUID()}, ${name}, ${email}, ${passwordEnc}, ${memberId})
      RETURNING "id", "name", "email", "memberId", "readerId", "createdAt"
    `;
    return rows[0];
  }

  async setReaderId(id, readerId) {
    await this.ensureTable();
    await prisma.$executeRaw`
      UPDATE "SumUpOperator" SET "readerId" = ${readerId}, "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;
  }

  async delete(id) {
    await this.ensureTable();
    await prisma.$executeRaw`DELETE FROM "SumUpOperator" WHERE "id" = ${id}`;
  }
}
