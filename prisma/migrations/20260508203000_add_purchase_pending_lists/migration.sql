CREATE TABLE IF NOT EXISTS "PurchasePendingList" (
  "id" TEXT PRIMARY KEY,
  "observation" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchasePendingList_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PurchasePendingListItem" (
  "id" TEXT PRIMARY KEY,
  "listId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchasePendingListItem_listId_fkey"
    FOREIGN KEY ("listId") REFERENCES "PurchasePendingList"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PurchasePendingListItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PurchasePendingList_createdAt_idx"
  ON "PurchasePendingList"("createdAt");
CREATE INDEX IF NOT EXISTS "PurchasePendingListItem_listId_idx"
  ON "PurchasePendingListItem"("listId");
CREATE INDEX IF NOT EXISTS "PurchasePendingListItem_productId_idx"
  ON "PurchasePendingListItem"("productId");
