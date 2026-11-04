import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { DeliveryService } from "../src/services/DeliveryService.js";

const estimate = vi.spyOn(DeliveryService.prototype, "estimateTravel");

const pedido = (extra) => ({
  userId: "u1",
  items: [{ productId: "db_milkshake_tradicional", size: "MEDIA", quantity: 1 }],
  ...extra,
});
const criado = () => tx.order.create.mock.calls[0][0].data;

describe("frete recalculado no servidor", () => {
  beforeEach(() => {
    tx.order.create.mockClear();
    estimate.mockReset();
  });

  it("cobra R$ 8 até 8 km, ignorando o valor mandado pelo site", async () => {
    estimate.mockResolvedValue({ distanciaKm: 7.9, tempoEstimado: 12 });
    await new OrderService({}, {}, {}).createOrder(
      pedido({ deliveryFee: 0, deliveryLat: -23.17, deliveryLon: -50.64 }),
    );
    expect(Number(criado().deliveryFee)).toBe(8);
    // Itens (13) + frete (8): é esse total que vai para a cobrança online
    expect(Number(criado().total)).toBe(21);
    expect(Number(criado().payment.create.amount)).toBe(21);
  });

  it("recusa entrega acima de 8 km", async () => {
    estimate.mockResolvedValue({ distanciaKm: 12.2, tempoEstimado: 15 });
    await expect(
      new OrderService({}, {}, {}).createOrder(
        pedido({ deliveryFee: 8, deliveryLat: -23.2, deliveryLon: -50.72 }),
      ),
    ).rejects.toThrow(/Não entregamos/);
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("recusa entrega sem as coordenadas do endereço", async () => {
    await expect(
      new OrderService({}, {}, {}).createOrder(pedido({ deliveryFee: 8 })),
    ).rejects.toThrow(/Calcule o frete/);
  });

  it("retirada no local não paga frete", async () => {
    await new OrderService({}, {}, {}).createOrder(pedido({ isPickup: true, deliveryFee: 8 }));
    expect(Number(criado().deliveryFee)).toBe(0);
    expect(Number(criado().total)).toBe(13);
    expect(estimate).not.toHaveBeenCalled();
  });
});
