import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma.js";

export class PurchaseListRepository {
  async createPendingList({ items, observation, createdBy }) {
    const listId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "PurchasePendingList" ("id", "observation", "createdBy")
        VALUES (${listId}, ${observation ?? null}, ${createdBy ?? null})
      `;

      for (const item of items) {
        await tx.$executeRaw`
          INSERT INTO "PurchasePendingListItem" ("id", "listId", "productId", "quantity")
          VALUES (${randomUUID()}, ${listId}, ${item.productId}, ${item.quantity})
        `;
      }
    });

    return this.getPendingListById(listId);
  }

  async listPendingLists() {
    const lists = await prisma.$queryRaw`
      SELECT "id", "observation", "createdBy", "createdAt"
      FROM "PurchasePendingList"
      ORDER BY "createdAt" DESC
    `;

    if (!lists.length) {
      return [];
    }

    const listIds = lists.map((list) => list.id);
    const items = await prisma.$queryRaw`
      SELECT
        i."id",
        i."listId",
        i."productId",
        i."quantity",
        p."name" AS "productName",
        p."stock",
        p."stockMinimum"
      FROM "PurchasePendingListItem" i
      INNER JOIN "Product" p ON p."id" = i."productId"
      WHERE i."listId" = ANY(${listIds})
      ORDER BY i."createdAt" ASC
    `;

    const itemsByList = new Map();
    for (const item of items) {
      if (!itemsByList.has(item.listId)) {
        itemsByList.set(item.listId, []);
      }
      itemsByList.get(item.listId).push({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        quantity: Number(item.quantity ?? 0),
        stock: Number(item.stock ?? 0),
        stockMinimum: Number(item.stockMinimum ?? 0),
      });
    }

    return lists.map((list) => ({
      id: list.id,
      observation: list.observation ?? null,
      createdBy: list.createdBy ?? null,
      createdAt: list.createdAt,
      items: itemsByList.get(list.id) ?? [],
    }));
  }

  async getPendingListById(listId) {
    const all = await this.listPendingLists();
    return all.find((list) => list.id === listId) ?? null;
  }

  async confirmPendingList(listId) {
    return prisma.$transaction(async (tx) => {
      const listRows = await tx.$queryRaw`
        SELECT "id"
        FROM "PurchasePendingList"
        WHERE "id" = ${listId}
        LIMIT 1
      `;

      if (!listRows.length) {
        return null;
      }

      const items = await tx.$queryRaw`
        SELECT "productId", "quantity"
        FROM "PurchasePendingListItem"
        WHERE "listId" = ${listId}
      `;

      for (const item of items) {
        await tx.$executeRaw`
          UPDATE "Product"
          SET "stock" = GREATEST(0, "stock" + ${Number(item.quantity ?? 0)})
          WHERE "id" = ${item.productId}
        `;
      }

      await tx.$executeRaw`
        DELETE FROM "PurchasePendingList"
        WHERE "id" = ${listId}
      `;

      return { movedItems: items.length };
    });
  }
}
