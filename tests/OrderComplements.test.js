import { describe, expect, it, vi } from "vitest";

const tx = {
  product: { findFirst: vi.fn(), findMany: vi.fn() },
  addon: { findMany: vi.fn() },
  order: { create: vi.fn(async ({ data }) => ({ id: "order-1", ...data })) },
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $transaction: vi.fn(async (fn) => fn(tx)) },
}));
vi.mock("../src/realtime/socketServer.js", () => ({
  emitOrderCreated: vi.fn(),
  emitOrderStatusUpdated: vi.fn(),
  emitPaymentUpdated: vi.fn(),
}));

import { OrderService } from "../src/services/OrderService.js";
import { AppError } from "../src/errors/AppError.js";

const milkshake = { id: "db_milkshake_tradicional", sizes: [{ price: 18 }] };
const ninho = {
  id: "db_mscomp_leite_ninho",
  name: "Leite Ninho",
  category: "complemento milkshake",
  sizes: [{ price: 3 }],
};

function setup({ addons = [], complements = [] }) {
  tx.product.findFirst.mockResolvedValue(milkshake);
  tx.addon.findMany.mockResolvedValue(addons);
  tx.product.findMany.mockResolvedValue(complements);
  tx.order.create.mockClear();
  return new OrderService({}, {}, {});
}

describe("complementos pagos no item do pedido", () => {
  it("soma o preço do complemento do milk shake ao item", async () => {
    const service = setup({ complements: [ninho] });

    await service.createOrder({
      userId: "u1",
      items: [{ productId: milkshake.id, addonIds: [ninho.id], quantity: 2 }],
    });

    const data = tx.order.create.mock.calls[0][0].data;
    expect(Number(data.total)).toBe(42); // (18 + 3) x 2
    expect(data.items.create[0].addons).toEqual([
      { id: ninho.id, name: "Leite Ninho", price: 3 },
    ]);
  });

  it("recusa produto que não é complemento pago", async () => {
    const service = setup({
      complements: [{ ...ninho, id: "x", category: "sabor milkshake tradicional" }],
    });

    await expect(
      service.createOrder({
        userId: "u1",
        items: [{ productId: milkshake.id, addonIds: ["x"] }],
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
