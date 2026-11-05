import { describe, expect, it, vi, beforeEach } from "vitest";
const paymentGetMock = vi.fn();

vi.mock("mercadopago", () => ({
  MercadoPagoConfig: vi.fn(),
  Payment: vi.fn().mockImplementation(() => ({
    get: paymentGetMock,
  })),
}));

import { OrderService } from "../src/services/OrderService.js";
import { AppError } from "../src/errors/AppError.js";

describe("OrderService", () => {
  beforeEach(() => {
    paymentGetMock.mockReset();
    delete process.env.MP_ACCESS_TOKEN;
  });

  it("deve permitir transicao valida de status", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({ id: "order-1", status: "RECEBIDO" })),
      updateStatus: vi.fn(async (_id, status) => ({ status })),
    };

    const service = new OrderService(orderRepository, {}, {});

    const updated = await service.updateOrderStatus("order-1", "PREPARANDO");

    expect(updated.status).toBe("PREPARANDO");
    expect(orderRepository.updateStatus).toHaveBeenCalledOnce();
  });

  it("deve bloquear transicao invalida de status", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({ id: "order-1", status: "RECEBIDO" })),
      updateStatus: vi.fn(),
    };

    const service = new OrderService(orderRepository, {}, {});

    await expect(
      service.updateOrderStatus("order-1", "NO_FORNO"),
    ).rejects.toBeInstanceOf(AppError);

    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });

  it("entrega sem motoboy sai com motoboy de fora e ja finaliza", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({
        id: "order-1",
        status: "PRONTO",
        userId: "u1",
        isPickup: false,
        mesaId: null,
        assignedMotoboyId: null,
      })),
      assignMotoboy: vi.fn(async () => {}),
      updateStatus: vi.fn(async (id, status) => ({ id, status })),
    };

    const service = new OrderService(orderRepository, {}, {});
    const updated = await service.updateOrderStatus(
      "order-1",
      "SAIU_PARA_ENTREGA",
    );

    expect(orderRepository.assignMotoboy).toHaveBeenCalledWith(
      "order-1",
      "EXTERNO",
    );
    expect(orderRepository.updateStatus.mock.calls.map((c) => c[1])).toEqual([
      "SAIU_PARA_ENTREGA",
      "ENTREGUE",
    ]);
    expect(orderRepository.updateStatus.mock.calls[1][2]).toBeInstanceOf(Date);
    expect(updated.status).toBe("ENTREGUE");
  });

  it("entrega com motoboy da loja continua em rota", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({
        id: "order-1",
        status: "PRONTO",
        isPickup: false,
        mesaId: null,
        assignedMotoboyId: "moto-1",
      })),
      assignMotoboy: vi.fn(),
      updateStatus: vi.fn(async (id, status) => ({ id, status })),
    };

    const service = new OrderService(orderRepository, {}, {});
    const updated = await service.updateOrderStatus(
      "order-1",
      "SAIU_PARA_ENTREGA",
    );

    expect(orderRepository.assignMotoboy).not.toHaveBeenCalled();
    expect(orderRepository.updateStatus).toHaveBeenCalledOnce();
    expect(updated.status).toBe("SAIU_PARA_ENTREGA");
  });

  it("motoboy de fora nao tem localizacao para o cliente", async () => {
    const orderRepository = {
      findById: vi.fn(async () => ({
        id: "order-1",
        status: "SAIU_PARA_ENTREGA",
        isPickup: false,
        assignedMotoboyId: "EXTERNO",
      })),
    };
    const service = new OrderService(orderRepository, {}, {});
    expect(await service.getOrderMotoboyLocation("order-1", null)).toBeNull();
  });

  it("deve vincular pagamento legado da maquininha pelo terminalIntentId salvo", async () => {
    process.env.MP_ACCESS_TOKEN = "token-teste";
    paymentGetMock.mockResolvedValue({
      id: 155356274197,
      status: "approved",
      external_reference: null,
      order: { id: "ORD01KPXW3PVAVJTCF7H2JEB4GZSK" },
      additional_info: {
        tracking_id: "platform:v1-blacklabel",
      },
    });

    const orderRepository = {
      findByTerminalIntentId: vi.fn(async (intentId) =>
        intentId === "ORD01KPXW3PVAVJTCF7H2JEB4GZSK"
          ? {
              id: "cmobsy4tt0001g51xll79kl3y",
              total: 1,
              userId: null,
            }
          : null,
      ),
      findById: vi.fn(async (orderId) => ({
        id: orderId,
        total: 1,
        userId: null,
      })),
      updatePaymentStatus: vi.fn(async (orderId, paymentStatus) => ({
        id: orderId,
        paymentStatus,
      })),
    };

    const paymentRepository = {
      upsertFromWebhook: vi.fn(async () => ({})),
    };

    const service = new OrderService(orderRepository, {}, paymentRepository);

    const result = await service.handlePaymentWebhook({
      topic: "payment",
      resource: "155356274197",
    });

    expect(orderRepository.findByTerminalIntentId).toHaveBeenCalledWith(
      "ORD01KPXW3PVAVJTCF7H2JEB4GZSK",
    );
    expect(paymentRepository.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "cmobsy4tt0001g51xll79kl3y",
        externalId: "155356274197",
        status: "APROVADO",
      }),
    );
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith(
      "cmobsy4tt0001g51xll79kl3y",
      "APROVADO",
    );
    expect(result).toEqual({
      orderId: "cmobsy4tt0001g51xll79kl3y",
      paymentStatus: "APROVADO",
    });
  });
});
