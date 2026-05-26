import { prisma } from "../lib/prisma.js";

export class MesaRepository {
  async create(data) {
    return prisma.mesa.create({ data });
  }

  async findAll() {
    return prisma.mesa.findMany({ orderBy: { number: "asc" } });
  }

  async findById(id) {
    return prisma.mesa.findUnique({ where: { id } });
  }

  async findByAccessToken(accessToken) {
    return prisma.mesa.findUnique({ where: { accessToken } });
  }

  async update(id, data) {
    return prisma.mesa.update({ where: { id }, data });
  }

  async delete(id) {
    return prisma.mesa.delete({ where: { id } });
  }

  async findAllOpenTotals() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await prisma.$queryRaw`
      SELECT
        o."mesaId",
        SUM(o.total) AS "pendingTotal",
        COUNT(o.id)  AS "activeCount"
      FROM "Order" o
      WHERE o."mesaId" IS NOT NULL
        AND o."createdAt" >= ${today}
        AND o.status::text <> 'CANCELADO'
        AND o."paymentStatus"::text <> 'APROVADO'
      GROUP BY o."mesaId"
    `;
    return rows.map((r) => ({
      mesaId: r.mesaId,
      pendingTotal: Number(r.pendingTotal ?? 0),
      activeCount: Number(r.activeCount ?? 0),
    }));
  }

  async findOrdersToday(mesaId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const orders = await prisma.order.findMany({
      where: {
        mesaId,
        createdAt: { gte: today },
        status: { notIn: ["CANCELADO"] },
      },
      include: {
        items: true,
        payment: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!orders.length) {
      return [];
    }

    const productIds = Array.from(
      new Set(
        orders
          .flatMap((order) => order.items ?? [])
          .map((item) => item.productId)
          .filter(Boolean),
      ),
    );

    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true },
        })
      : [];

    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );

    return orders.map((order) => ({
      ...order,
      items: (order.items ?? []).map((item) => ({
        ...item,
        product: productMap.get(item.productId) ?? null,
      })),
    }));
  }
}
