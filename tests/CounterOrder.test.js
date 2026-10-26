import { describe, expect, it, vi } from "vitest";

const tx = {
  product: {
    findFirst: vi.fn(async () => ({ id: "db_milkshake_tradicional", sizes: [{ price: 13 }] })),
    findMany: vi.fn(async () => []),
  },
  addon: { findMany: vi.fn(async () => []) },
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
import { createCounterOrderSchema } from "../src/validators/orderSchemas.js";

describe("pedido do balcão (caixa)", () => {
  it("cria retirada com o nome do cliente e já dá baixa no pagamento", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({ id: "order-1", status: "RECEBIDO", paymentStatus: "PENDENTE" })),
      updatePaymentStatus: vi.fn(async (id, status, method) => ({ id, paymentStatus: status, paymentMethod: method })),
    };
    const service = new OrderService(orderRepository, {}, {});

    const order = await service.createCounterOrder({
      staff: { id: "caixa-1", role: "FUNCIONARIO" },
      customerName: "Maria",
      paymentMethod: "PIX",
      items: [{ productId: "db_milkshake_tradicional", quantity: 1 }],
    });

    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.userId).toBe("caixa-1");
    expect(data.isPickup).toBe(true);
    expect(data.notes).toBe("Pedido no Caixa | Cliente: Maria");
    expect(Number(data.total)).toBe(13);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("order-1", "APROVADO", "PIX");
    expect(order.paymentStatus).toBe("APROVADO");
  });

  it("exige nome do cliente e forma de pagamento válida", () => {
    const items = [{ productId: "p1" }];
    expect(() => createCounterOrderSchema.parse({ customerName: " ", paymentMethod: "PIX", items })).toThrow();
    expect(() => createCounterOrderSchema.parse({ customerName: "Ana", paymentMethod: "FIADO", items })).toThrow();
    expect(createCounterOrderSchema.parse({ customerName: " Ana ", paymentMethod: "DINHEIRO", items }).customerName).toBe("Ana");
  });
});
