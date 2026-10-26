import { describe, expect, it, vi } from "vitest";

const tx = {
  product: {
    findFirst: vi.fn(async () => ({ id: "db_milkshake_tradicional", sizes: [{ size: "MEDIA", price: 13 }] })),
    findMany: vi.fn(async () => []),
  },
  addon: { findMany: vi.fn(async () => []) },
  order: { create: vi.fn(async ({ data }) => ({ id: "order-1", ...data })) },
  $queryRaw: vi.fn(async () => []),
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $transaction: vi.fn(async (fn) => fn(tx)), $executeRawUnsafe: vi.fn(async () => 0) },
}));
vi.mock("../src/realtime/socketServer.js", () => ({
  emitOrderCreated: vi.fn(),
  emitOrderStatusUpdated: vi.fn(),
  emitPaymentUpdated: vi.fn(),
}));

import { OrderService } from "../src/services/OrderService.js";
import { PromotionService } from "../src/services/PromotionService.js";

const pedido = () => ({
  userId: "u1",
  items: [{ productId: "db_milkshake_tradicional", size: "MEDIA", quantity: 2 }],
});

describe("preço promocional no pedido", () => {
  it("cobra o preço da promoção que está valendo", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ price: "10.00" }]);
    tx.order.create.mockClear();
    await new OrderService({}, {}, {}).createOrder(pedido());
    expect(Number(tx.order.create.mock.calls[0][0].data.total)).toBe(20);
  });

  it("sem promoção, cobra o preço normal", async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    tx.order.create.mockClear();
    await new OrderService({}, {}, {}).createOrder(pedido());
    expect(Number(tx.order.create.mock.calls[0][0].data.total)).toBe(26);
  });

  it("promoção mais cara que o normal é ignorada", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ price: "15.00" }]);
    tx.order.create.mockClear();
    await new OrderService({}, {}, {}).createOrder(pedido());
    expect(Number(tx.order.create.mock.calls[0][0].data.total)).toBe(26);
  });
});

describe("cadastro de promoção", () => {
  const repo = { create: vi.fn(async (data) => data), update: vi.fn(), list: vi.fn(), listActive: vi.fn(), remove: vi.fn() };
  const service = new PromotionService(repo);
  const base = {
    title: "Tradicional M por 10",
    productId: "db_milkshake_tradicional",
    size: "MEDIA",
    price: "10",
    startsAt: "2026-11-01T10:00:00-03:00",
    endsAt: "2026-11-01T20:00:00-03:00",
  };

  it("aceita uma promoção válida", async () => {
    const created = await service.create(base);
    expect(created).toMatchObject({ price: 10, size: "MEDIA", isActive: true });
  });

  it("recusa fim antes do início e preço zero", async () => {
    await expect(service.create({ ...base, endsAt: "2026-11-01T09:00:00-03:00" })).rejects.toThrow(/depois do início/);
    await expect(service.create({ ...base, price: 0 })).rejects.toThrow(/maior que zero/);
  });
});
