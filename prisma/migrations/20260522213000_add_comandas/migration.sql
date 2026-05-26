DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'COMANDA'
      AND enumtypid = '"Role"'::regtype
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'COMANDA';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "Comanda" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "accessToken" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Comanda_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Comanda_number_key" ON "Comanda"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "Comanda_accessToken_key" ON "Comanda"("accessToken");

ALTER TABLE "Order"
ADD COLUMN IF NOT EXISTS "comandaId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Order_comandaId_fkey'
  ) THEN
    ALTER TABLE "Order"
    ADD CONSTRAINT "Order_comandaId_fkey"
    FOREIGN KEY ("comandaId") REFERENCES "Comanda"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
