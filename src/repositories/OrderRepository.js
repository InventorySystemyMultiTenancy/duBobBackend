import { prisma } from "../lib/prisma.js";

export class OrderRepository {
  _isMissingColumnError(error) {
    const message = String(error?.message ?? "").toLowerCase();
    return error?.code === "42703" || message.includes("does not exist");
  }

  _logDbError(context, error) {
    console.error(`[${context}] erro SQL`, {
      prismaCode: error?.code ?? null,
      dbCode: error?.meta?.code ?? null,
      dbMessage: error?.meta?.message ?? null,
      message: error?.message ?? null,
    });
  }

  async _logTableColumns(context, tableName) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
        ORDER BY ordinal_position
      `;

      const columns = rows.map((r) => r.column_name);
      console.log(`[${context}] schema ${tableName} columns=`, columns);
    } catch (schemaError) {
      console.warn(
        `[${context}] falha ao ler information_schema para ${tableName}:`,
        schemaError?.message,
      );
    }
  }

  _pick(obj, keys, fallback = null) {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
    return fallback;
  }

  _normalizeLegacyOrder(raw) {
    return {
      id: this._pick(raw, ["id"]),
      userId: this._pick(raw, ["userId", "user_id", "userid"]),
      mesaId: this._pick(raw, ["mesaId", "mesa_id", "mesaid"]),
      comandaId: this._pick(raw, ["comandaId", "comanda_id", "comandaid"]),
      status: this._pick(raw, ["status"], "RECEBIDO"),
      paymentStatus: this._pick(
        raw,
        ["paymentStatus", "payment_status", "paymentstatus"],
        "PENDENTE",
      ),
      deliveryAddress: this._pick(raw, ["deliveryAddress", "delivery_address"]),
      notes: this._pick(raw, ["notes"]),
      paymentMethod: this._pick(raw, ["paymentMethod", "payment_method"]),
      total: this._pick(raw, ["total"], 0),
      createdAt: this._pick(raw, ["createdAt", "created_at"]),
      updatedAt: this._pick(raw, ["updatedAt", "updated_at"]),
      deliveryFee: this._pick(raw, ["deliveryFee", "delivery_fee"]),
      deliveryLat: this._pick(raw, ["deliveryLat", "delivery_lat"]),
      deliveryLon: this._pick(raw, ["deliveryLon", "delivery_lon"]),
      isPickup: this._pick(raw, ["isPickup", "is_pickup"], false),
      assignedMotoboyId: this._pick(raw, [
        "assignedMotoboyId",
        "assigned_motoboy_id",
      ]),
      deliveryCode: this._pick(raw, ["deliveryCode", "delivery_code"]),
      deliveredAt: this._pick(raw, ["deliveredAt", "delivered_at"]),
    };
  }

  async _findByUserIdFromJsonFallback(userId) {
    const rows = await prisma.$queryRaw`
      SELECT to_jsonb(o) AS row
      FROM "Order" o
    `;

    const normalized = rows
      .map((r) => this._normalizeLegacyOrder(r.row ?? {}))
      .filter((o) => String(o.userId ?? "") === String(userId));

    normalized.sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    return normalized;
  }

  // Helpers: Prisma v6 não suporta arrays em $queryRaw template tags;
  // usamos $queryRawUnsafe com placeholders IN ($1, $2, ...) em vez de ANY($1::text[])
  async _fetchItemsForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(
        `SELECT oi.*, p.name AS "productName", p."imageUrl" AS "productImageUrl", p."waiterOnly" AS "productWaiterOnly"
         FROM "OrderItem" oi
         LEFT JOIN "Product" p ON p.id = oi."productId"
         WHERE oi."orderId" IN (${ph})`,
        ...orderIds,
      );
    } catch (error) {
      if (!this._isMissingColumnError(error)) {
        throw error;
      }

      console.warn(
        "[_fetchItemsForOrders] fallback legado (snake_case):",
        error.message,
      );

      try {
        rows = await prisma.$queryRawUnsafe(
          `SELECT
             oi.id,
             oi."order_id" AS "orderId",
             oi."product_id" AS "productId",
             oi.quantity,
             oi."unit_price" AS "unitPrice",
             oi."total_price" AS "totalPrice",
             oi.addons,
             oi."removed_ingredients" AS "removedIngredients",
             oi.notes,
             p.name AS "productName",
             p."imageUrl" AS "productImageUrl",
             p."waiterOnly" AS "productWaiterOnly"
           FROM "OrderItem" oi
           LEFT JOIN "Product" p ON p.id = oi."product_id"
           WHERE oi."order_id" IN (${ph})`,
          ...orderIds,
        );
      } catch (legacyError) {
        if (!this._isMissingColumnError(legacyError)) {
          throw legacyError;
        }

        console.warn(
          "[_fetchItemsForOrders] fallback JSON legado:",
          legacyError.message,
        );

        const jsonRows = await prisma.$queryRaw`
          SELECT to_jsonb(oi) AS row
          FROM "OrderItem" oi
        `;

        rows = jsonRows
          .map((r) => r.row ?? {})
          .map((row) => ({
            id: this._pick(row, ["id"]),
            orderId: this._pick(row, ["orderId", "order_id", "orderid"]),
            productId: this._pick(row, [
              "productId",
              "product_id",
              "productid",
            ]),
            quantity: this._pick(row, ["quantity"], 1),
            unitPrice: this._pick(row, ["unitPrice", "unit_price"], 0),
            totalPrice: this._pick(row, ["totalPrice", "total_price"], 0),
            addons: this._pick(row, ["addons"]),
            removedIngredients: this._pick(row, [
              "removedIngredients",
              "removed_ingredients",
            ]),
            notes: this._pick(row, ["notes"]),
            productName: null,
            productImageUrl: null,
            productWaiterOnly: false,
          }))
          .filter((row) => orderIds.includes(row.orderId));
      }
    }

    return rows.map((row) => ({
      ...row,
      product: row.productName
        ? {
            id: row.productId,
            name: row.productName,
            imageUrl: row.productImageUrl,
            image: row.productImageUrl,
            waiterOnly: Boolean(row.productWaiterOnly),
          }
        : null,
    }));
  }

  async _fetchPaymentsForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    try {
      return await prisma.$queryRawUnsafe(
        `SELECT * FROM "Payment" WHERE "orderId" IN (${ph})`,
        ...orderIds,
      );
    } catch (error) {
      if (!this._isMissingColumnError(error)) {
        throw error;
      }

      console.warn(
        "[_fetchPaymentsForOrders] fallback legado (snake_case):",
        error.message,
      );

      try {
        return await prisma.$queryRawUnsafe(
          `SELECT
             id,
             "order_id" AS "orderId",
             provider,
             "external_id" AS "externalId",
             amount,
             status::text AS status,
             payload,
             "created_at" AS "createdAt",
             "updated_at" AS "updatedAt"
           FROM "Payment"
           WHERE "order_id" IN (${ph})`,
          ...orderIds,
        );
      } catch (legacyError) {
        if (!this._isMissingColumnError(legacyError)) {
          throw legacyError;
        }

        console.warn(
          "[_fetchPaymentsForOrders] fallback JSON legado:",
          legacyError.message,
        );

        const jsonRows = await prisma.$queryRaw`
          SELECT to_jsonb(p) AS row
          FROM "Payment" p
        `;

        return jsonRows
          .map((r) => r.row ?? {})
          .map((row) => ({
            id: this._pick(row, ["id"]),
            orderId: this._pick(row, ["orderId", "order_id", "orderid"]),
            provider: this._pick(row, ["provider"]),
            externalId: this._pick(row, ["externalId", "external_id"]),
            amount: this._pick(row, ["amount"], 0),
            status: this._pick(row, ["status"], "PENDENTE"),
            payload: this._pick(row, ["payload"]),
            createdAt: this._pick(row, ["createdAt", "created_at"]),
            updatedAt: this._pick(row, ["updatedAt", "updated_at"]),
          }))
          .filter((row) => orderIds.includes(row.orderId));
      }
    }
  }

  async _fetchUsersForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    try {
      return await prisma.$queryRawUnsafe(
        `SELECT u.id, u.name FROM "User" u
         WHERE u.id IN (
           SELECT DISTINCT "userId" FROM "Order"
           WHERE id IN (${ph}) AND "userId" IS NOT NULL
         )`,
        ...orderIds,
      );
    } catch (error) {
      if (!this._isMissingColumnError(error)) {
        this._logDbError("_fetchUsersForOrders/main", error);
        throw error;
      }

      this._logDbError("_fetchUsersForOrders/main", error);
      await this._logTableColumns("_fetchUsersForOrders/main", "Order");
      await this._logTableColumns("_fetchUsersForOrders/main", "User");

      console.warn(
        "[_fetchUsersForOrders] fallback legado (snake_case):",
        error.message,
      );

      try {
        return await prisma.$queryRawUnsafe(
          `SELECT u.id, u.name FROM "User" u
           WHERE u.id IN (
             SELECT DISTINCT "user_id" FROM "Order"
             WHERE id IN (${ph}) AND "user_id" IS NOT NULL
           )`,
          ...orderIds,
        );
      } catch (legacyError) {
        if (!this._isMissingColumnError(legacyError)) {
          this._logDbError("_fetchUsersForOrders/snake_case", legacyError);
          throw legacyError;
        }

        this._logDbError("_fetchUsersForOrders/snake_case", legacyError);
        await this._logTableColumns("_fetchUsersForOrders/snake_case", "Order");

        console.warn(
          "[_fetchUsersForOrders] fallback JSON legado:",
          legacyError.message,
        );

        const rows = await prisma.$queryRaw`
          SELECT id, name
          FROM "User"
        `;
        return rows;
      }
    }
  }

  async createOrder(data) {
    return prisma.order.create({
      data,
      include: {
        items: true,
        payment: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async findById(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT o.id, o."userId", o."mesaId", o."comandaId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             o."deliveryAddress", o.notes, o."paymentMethod",
             o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
             o."isPickup", o."assignedMotoboyId", o."deliveryCode",
             o."createdAt", o."updatedAt", o."deliveredAt"
      FROM "Order" o WHERE o.id = ${orderId}
    `;
    if (!rows.length) return null;
    const order = rows[0];

    const items = await prisma.$queryRaw`
      SELECT oi.*, p.name AS "productName", p."imageUrl" AS "productImageUrl", p."waiterOnly" AS "productWaiterOnly"
      FROM "OrderItem" oi
      LEFT JOIN "Product" p ON p.id = oi."productId"
      WHERE oi."orderId" = ${orderId}
    `;
    const payments = await prisma.$queryRaw`
      SELECT * FROM "Payment" WHERE "orderId" = ${orderId}
    `;
    return {
      ...order,
      items: items.map((item) => ({
        ...item,
        product: item.productName
          ? {
              id: item.productId,
              name: item.productName,
              imageUrl: item.productImageUrl,
              image: item.productImageUrl,
              waiterOnly: Boolean(item.productWaiterOnly),
            }
          : null,
      })),
      payment: payments[0] ?? null,
    };
  }

  async findByIdWithUser(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT o.id, o."userId", o."mesaId", o."comandaId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             u.id AS "uId", u.role::text AS "uRole"
      FROM "Order" o
      LEFT JOIN "User" u ON u.id = o."userId"
      WHERE o.id = ${orderId}
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      userId: r.userId,
      mesaId: r.mesaId,
      comandaId: r.comandaId,
      status: r.status,
      paymentStatus: r.paymentStatus,
      user: r.uId ? { id: r.uId, role: r.uRole } : null,
    };
  }

  async updateStatus(orderId, status, deliveredAt = null) {
    // Usa raw SQL para todos os updates de status para evitar problemas
    // com o Prisma Client desatualizado que não conhece CANCELADO
    const deliveredClause = deliveredAt
      ? `, "deliveredAt" = '${new Date(deliveredAt).toISOString()}'`
      : "";
    await prisma.$executeRawUnsafe(
      `UPDATE "Order" SET "status" = $1::"OrderStatus", "updatedAt" = NOW()${deliveredClause} WHERE "id" = $2`,
      status,
      orderId,
    );
    return this.findById(orderId);
  }

  async updatePaymentStatus(orderId, paymentStatus, paymentMethod) {
    return prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus,
        ...(paymentMethod !== undefined ? { paymentMethod } : {}),
      },
    });
  }

  async saveTerminalIntentId(orderId, intentId) {
    await prisma.$executeRaw`
      UPDATE "Order" SET "terminalIntentId" = ${intentId}, "updatedAt" = NOW()
      WHERE "id" = ${orderId}
    `;
  }

  async findByTerminalIntentId(intentId) {
    const rows = await prisma.$queryRaw`
      SELECT id, "paymentStatus"::text AS "paymentStatus", "mesaId", "userId", total
      FROM "Order"
      WHERE "terminalIntentId" = ${intentId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Busca o pedido pendente mais recente da maquininha (terminalIntentId não nulo)
   * cujo total bate com o valor do pagamento aprovado.
   * Usado como fallback quando o MP não retorna external_reference.
   */
  async findPendingTerminalOrderByAmount(amountCents) {
    const amountDecimal = (amountCents / 100).toFixed(2);
    const rows = await prisma.$queryRaw`
      SELECT id, "paymentStatus"::text AS "paymentStatus", "mesaId", "userId", total
      FROM "Order"
      WHERE "paymentStatus" = 'PENDENTE'
        AND "terminalIntentId" IS NOT NULL
        AND ROUND(total::numeric, 2) = ${parseFloat(amountDecimal)}
        AND "createdAt" >= NOW() - INTERVAL '24 hours'
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findByUserId(userId) {
    console.log("[findByUserId] start userId=", userId);
    let orders;
    try {
      orders = await prisma.$queryRaw`
        SELECT
          o.id, o."userId", o.status::text AS status,
          o."paymentStatus"::text AS "paymentStatus",
          o."deliveryAddress", o.notes, o."paymentMethod",
          o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
          o."isPickup", o."assignedMotoboyId", o."deliveryCode",
          o."createdAt", o."updatedAt", o."deliveredAt"
        FROM "Order" o
        WHERE o."userId" = ${userId}
        ORDER BY o."createdAt" DESC
      `;
      console.log("[findByUserId] orders count=", orders.length);
    } catch (e) {
      if (this._isMissingColumnError(e)) {
        console.warn(
          "[findByUserId] fallback ativado por coluna ausente no banco:",
          e.message,
        );

        try {
          // Compatibilidade com bancos legados em snake_case.
          orders = await prisma.$queryRaw`
            SELECT
              o.id,
              o."user_id" AS "userId",
              o.status::text AS status,
              o."payment_status"::text AS "paymentStatus",
              o."delivery_address" AS "deliveryAddress",
              o.notes,
              o."payment_method" AS "paymentMethod",
              o.total,
              o."created_at" AS "createdAt",
              o."updated_at" AS "updatedAt"
            FROM "Order" o
            WHERE o."user_id" = ${userId}
            ORDER BY o."created_at" DESC
          `;
        } catch (snakeCaseError) {
          if (!this._isMissingColumnError(snakeCaseError)) {
            throw snakeCaseError;
          }

          console.warn(
            "[findByUserId] fallback JSON legado:",
            snakeCaseError.message,
          );
          orders = await this._findByUserIdFromJsonFallback(userId);
        }

        orders = orders.map((order) => ({
          ...order,
          deliveryFee: null,
          deliveryLat: null,
          deliveryLon: null,
          isPickup: false,
          assignedMotoboyId: null,
          deliveryCode: null,
          deliveredAt: null,
        }));

        console.log("[findByUserId] fallback orders count=", orders.length);
      } else {
        console.error("[findByUserId] FALHOU na query de orders:", e);
        throw e;
      }
    }

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);
    console.log("[findByUserId] orderIds=", orderIds);

    let items, payments;
    try {
      items = await this._fetchItemsForOrders(orderIds);
      console.log("[findByUserId] items count=", items.length);
    } catch (e) {
      console.error("[findByUserId] FALHOU em _fetchItemsForOrders:", e);
      throw e;
    }
    try {
      payments = await this._fetchPaymentsForOrders(orderIds);
      console.log("[findByUserId] payments count=", payments.length);
    } catch (e) {
      console.error("[findByUserId] FALHOU em _fetchPaymentsForOrders:", e);
      throw e;
    }

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
      payment: payments.find((p) => p.orderId === o.id) ?? null,
    }));
  }

  async assignMotoboy(orderId, motoboyId) {
    await prisma.$executeRaw`
      UPDATE "Order" SET "assignedMotoboyId" = ${motoboyId} WHERE id = ${orderId}
    `;
  }

  async confirmDelivery(orderId, code) {
    const rows = await prisma.$queryRaw`
      SELECT "deliveryCode", status::text AS status, "isPickup"
      FROM "Order" WHERE id = ${orderId}
    `;
    if (!rows.length) return null;
    const order = rows[0];
    if (order.status !== "SAIU_PARA_ENTREGA") {
      throw new Error("STATUS_INVALID");
    }
    if (order.isPickup) {
      throw new Error("IS_PICKUP");
    }
    if (order.deliveryCode !== code) {
      throw new Error("CODE_INVALID");
    }
    return this.updateStatus(orderId, "ENTREGUE", new Date());
  }

  async deleteById(orderId, userId) {
    // Must delete related rows first (Payment, OrderItem) then the Order itself
    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM "Payment" WHERE "orderId" = ${orderId}`,
      prisma.$executeRaw`DELETE FROM "OrderItem" WHERE "orderId" = ${orderId}`,
      prisma.$executeRaw`DELETE FROM "Order" WHERE id = ${orderId} AND "userId" = ${userId} AND status::text = 'CANCELADO'`,
    ]);
  }

  async findOwnerAndStatus(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT "userId", status::text AS status FROM "Order" WHERE id = ${orderId}
    `;
    return rows[0] ?? null;
  }

  async _fetchMesasForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    try {
      return await prisma.$queryRawUnsafe(
        `SELECT m.id, m.name, m.number FROM "Mesa" m
         WHERE m.id IN (
           SELECT DISTINCT "mesaId" FROM "Order"
           WHERE id IN (${ph}) AND "mesaId" IS NOT NULL
         )`,
        ...orderIds,
      );
    } catch (error) {
      if (!this._isMissingColumnError(error)) {
        this._logDbError("_fetchMesasForOrders/main", error);
        throw error;
      }

      this._logDbError("_fetchMesasForOrders/main", error);
      await this._logTableColumns("_fetchMesasForOrders/main", "Order");
      await this._logTableColumns("_fetchMesasForOrders/main", "Mesa");

      console.warn(
        "[_fetchMesasForOrders] fallback legado (snake_case):",
        error.message,
      );

      return prisma.$queryRawUnsafe(
        `SELECT m.id, m.name, m.number FROM "Mesa" m
         WHERE m.id IN (
           SELECT DISTINCT "mesa_id" FROM "Order"
           WHERE id IN (${ph}) AND "mesa_id" IS NOT NULL
         )`,
        ...orderIds,
      );
    }
  }

  async _fetchComandasForOrders(orderIds) {
    if (!orderIds.length) return [];
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(",");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "comandaId" FROM "Order"
       WHERE id IN (${ph}) AND "comandaId" IS NOT NULL`,
      ...orderIds,
    );
    const ids = rows.map((r) => r.comandaId).filter(Boolean);
    if (!ids.length) return [];

    return prisma.comanda.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, number: true },
    });
  }

  async findAllActive() {
    console.log("[findAllActive] start");
    let orders;
    try {
      orders = await prisma.$queryRaw`
        SELECT
             o.id, o."userId", o."mesaId", o."comandaId", o.status::text AS status,
          o."paymentStatus"::text AS "paymentStatus",
          o."deliveryAddress", o.notes, o."paymentMethod",
          o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
          o."isPickup", o."assignedMotoboyId",
          o."createdAt", o."updatedAt", o."deliveredAt"
        FROM "Order" o
        WHERE o.status::text NOT IN ('ENTREGUE','CANCELADO')
        ORDER BY o."createdAt" ASC
      `;
      console.log("[findAllActive] orders count=", orders.length);
    } catch (e) {
      if (this._isMissingColumnError(e)) {
        this._logDbError("findAllActive/main", e);
        await this._logTableColumns("findAllActive/main", "Order");

        console.warn(
          "[findAllActive] fallback ativado por coluna ausente no banco:",
          e.message,
        );

        try {
          orders = await prisma.$queryRaw`
            SELECT
              o.id,
              o."user_id" AS "userId",
              o."mesa_id" AS "mesaId",
              o.status::text AS status,
              o."payment_status"::text AS "paymentStatus",
              o."delivery_address" AS "deliveryAddress",
              o.notes,
              o."payment_method" AS "paymentMethod",
              o.total,
              o."delivery_fee" AS "deliveryFee",
              o."delivery_lat" AS "deliveryLat",
              o."delivery_lon" AS "deliveryLon",
              o."is_pickup" AS "isPickup",
              o."assigned_motoboy_id" AS "assignedMotoboyId",
              o."created_at" AS "createdAt",
              o."updated_at" AS "updatedAt",
              o."delivered_at" AS "deliveredAt"
            FROM "Order" o
            WHERE o.status::text NOT IN ('ENTREGUE','CANCELADO')
            ORDER BY o."created_at" ASC
          `;
        } catch (snakeCaseError) {
          if (!this._isMissingColumnError(snakeCaseError)) {
            this._logDbError("findAllActive/snake_case", snakeCaseError);
            throw snakeCaseError;
          }

          this._logDbError("findAllActive/snake_case", snakeCaseError);
          await this._logTableColumns("findAllActive/snake_case", "Order");

          console.warn(
            "[findAllActive] fallback JSON legado:",
            snakeCaseError.message,
          );

          const jsonRows = await prisma.$queryRaw`
            SELECT to_jsonb(o) AS row
            FROM "Order" o
          `;

          orders = jsonRows
            .map((r) => this._normalizeLegacyOrder(r.row ?? {}))
            .filter(
              (o) =>
                !["ENTREGUE", "CANCELADO"].includes(
                  String(o.status ?? "").toUpperCase(),
                ),
            )
            .sort((a, b) => {
              const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return da - db;
            });
        }

        orders = orders.map((order) => ({
          ...order,
          deliveryFee: order.deliveryFee ?? null,
          deliveryLat: order.deliveryLat ?? null,
          deliveryLon: order.deliveryLon ?? null,
          isPickup: order.isPickup ?? false,
          assignedMotoboyId: order.assignedMotoboyId ?? null,
          deliveredAt: order.deliveredAt ?? null,
        }));

        console.log("[findAllActive] fallback orders count=", orders.length);
        console.log("[findAllActive] fallback sample order keys=", {
          keys: orders[0] ? Object.keys(orders[0]) : [],
        });
      } else {
        this._logDbError("findAllActive/main", e);
        console.error("[findAllActive] FALHOU na query de orders:", e);
        throw e;
      }
    }

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);
    console.log("[findAllActive] orderIds=", orderIds);
    console.log("[findAllActive] sample order keys=", {
      keys: orders[0] ? Object.keys(orders[0]) : [],
    });

    let items, users, mesas, comandas;
    try {
      items = await this._fetchItemsForOrders(orderIds);
      console.log("[findAllActive] items count=", items.length);
    } catch (e) {
      console.error("[findAllActive] FALHOU em _fetchItemsForOrders:", e);
      throw e;
    }
    try {
      users = await this._fetchUsersForOrders(orderIds);
      console.log("[findAllActive] users count=", users.length);
    } catch (e) {
      console.error("[findAllActive] FALHOU em _fetchUsersForOrders:", e);
      throw e;
    }
    try {
      mesas = await this._fetchMesasForOrders(orderIds);
    } catch (e) {
      mesas = [];
    }
    try {
      comandas = await this._fetchComandasForOrders(orderIds);
    } catch (e) {
      comandas = [];
    }

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
      user: users.find((u) => u.id === o.userId) ?? null,
      mesa: mesas.find((m) => m.id === o.mesaId) ?? null,
      comanda: comandas.find((c) => c.id === o.comandaId) ?? null,
    }));
  }

  async findPendingPayments() {
    const orders = await prisma.$queryRaw`
      SELECT
        o.id, o."userId", o."mesaId", o."comandaId", o.status::text AS status,
        o."paymentStatus"::text AS "paymentStatus",
        o."deliveryAddress", o.notes, o."paymentMethod",
        o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
        o."isPickup", o."assignedMotoboyId",
        o."createdAt", o."updatedAt", o."deliveredAt"
      FROM "Order" o
      WHERE o.status::text <> 'CANCELADO'
        AND o."paymentStatus"::text <> 'APROVADO'
      ORDER BY o."createdAt" ASC
    `;

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);
    const items = await this._fetchItemsForOrders(orderIds);
    const users = await this._fetchUsersForOrders(orderIds);

    let mesas = [];
    let comandas = [];
    try {
      mesas = await this._fetchMesasForOrders(orderIds);
    } catch (_error) {
      mesas = [];
    }
    try {
      comandas = await this._fetchComandasForOrders(orderIds);
    } catch (_error) {
      comandas = [];
    }

    return orders.map((order) => ({
      ...order,
      items: items.filter((item) => item.orderId === order.id),
      user: users.find((user) => user.id === order.userId) ?? null,
      mesa: mesas.find((mesa) => mesa.id === order.mesaId) ?? null,
      comanda:
        comandas.find((comanda) => comanda.id === order.comandaId) ?? null,
    }));
  }

  async findForMotoboy({ assignedMotoboyId } = {}) {
    const where = {
      status: "SAIU_PARA_ENTREGA",
      ...(assignedMotoboyId ? { assignedMotoboyId } : {}),
    };

    return prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
          },
        },
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async findAllHistory({ clientName, dateFrom, dateTo } = {}) {
    const hasFilter = clientName || dateFrom || dateTo;

    // Constrói cláusulas WHERE dinamicamente para raw SQL
    const conditions = [];
    const params = [];
    let idx = 1;

    if (clientName) {
      conditions.push(`u.name ILIKE $${idx}`);
      params.push(`%${clientName}%`);
      idx++;
    }
    if (dateFrom) {
      conditions.push(`o."createdAt" >= $${idx}`);
      params.push(new Date(dateFrom));
      idx++;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      conditions.push(`o."createdAt" <= $${idx}`);
      params.push(end);
      idx++;
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const orders = await prisma.$queryRawUnsafe(
      `SELECT o.id, o."userId", o."mesaId", o.status::text AS status,
              o."paymentStatus"::text AS "paymentStatus",
              o."deliveryAddress", o.notes, o."paymentMethod",
              o.total, o."deliveryFee", o."deliveryLat", o."deliveryLon",
              o."isPickup", o."assignedMotoboyId", o."deliveryCode",
              o."terminalIntentId",
              o."createdAt", o."updatedAt", o."deliveredAt",
              u.name AS "userName",
              mesa.id AS "mesaTableId", mesa.name AS "mesaName", mesa.number AS "mesaNumber",
              motoboy.name AS "motoboyName"
       FROM "Order" o
       LEFT JOIN "User" u ON u.id = o."userId"
       LEFT JOIN "Mesa" mesa ON mesa.id = o."mesaId"
       LEFT JOIN "User" motoboy ON motoboy.id = o."assignedMotoboyId"
       ${whereClause}
       ORDER BY o."createdAt" DESC`,
      ...params,
    );

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);

    const items = await this._fetchItemsForOrders(orderIds);
    const payments = await this._fetchPaymentsForOrders(orderIds);

    return orders.map((o) => ({
      ...o,
      user: o.userId ? { id: o.userId, name: o.userName } : null,
      mesa: o.mesaId
        ? {
            id: o.mesaTableId ?? o.mesaId,
            name: o.mesaName,
            number: o.mesaNumber,
          }
        : null,
      assignedMotoboy: o.assignedMotoboyId
        ? { id: o.assignedMotoboyId, name: o.motoboyName }
        : null,
      items: items.filter((i) => i.orderId === o.id),
      payment: payments.find((p) => p.orderId === o.id) ?? null,
    }));
  }

  async findAllForAnalytics() {
    const orders = await prisma.$queryRaw`
      SELECT o.id, o."userId", o.status::text AS status,
             o."paymentStatus"::text AS "paymentStatus",
             o.total, o."deliveryFee", o."paymentMethod",
             o."mesaId", o."isPickup", o."createdAt"
      FROM "Order" o
      ORDER BY o."createdAt" ASC
    `;

    if (!orders.length) return [];

    const orderIds = orders.map((o) => o.id);

    // Busca itens com costPrice do tamanho correspondente
    const ph = orderIds.map((_, i) => `$${i + 1}`).join(", ");
    const items = await prisma.$queryRawUnsafe(
      `SELECT oi."orderId", oi.quantity,
              oi."unitPrice", oi."totalPrice",
              oi."productId",
              p.name AS "productName",
              COALESCE(ps."costPrice", 0) AS "costPrice"
       FROM "OrderItem" oi
       LEFT JOIN "Product" p ON p.id = oi."productId"
       LEFT JOIN "ProductSize" ps ON ps."productId" = oi."productId"
       WHERE oi."orderId" IN (${ph})`,
      ...orderIds,
    );

    return orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id),
    }));
  }
}
