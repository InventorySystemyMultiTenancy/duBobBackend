import { prisma } from "../lib/prisma.js";

export class AppSettingRepository {
  async ensureTable() {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "AppSetting" (
        "key" TEXT PRIMARY KEY,
        "value" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  async get(key) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${key} LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async set(key, value) {
    await this.ensureTable();
    const rows = await prisma.$queryRaw`
      INSERT INTO "AppSetting" ("key", "value", "updatedAt")
      VALUES (${key}, ${value}, NOW())
      ON CONFLICT ("key")
      DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()
      RETURNING "key", "value"
    `;
    return rows[0] ?? null;
  }
}
