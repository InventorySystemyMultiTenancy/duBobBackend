import dotenv from "dotenv";
import http from "http";
import { app } from "./app.js";
import { initializeSocketServer } from "./realtime/socketServer.js";
import { prisma } from "./lib/prisma.js";

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
    `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
    `ALTER TABLE "ProductSize" ADD COLUMN IF NOT EXISTS "label" TEXT`,
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
  server.listen(port, () => {
    console.log(`API Dubob rodando na porta ${port}`);
  });
});
