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

  it("deve calcular pizza meio a meio pelo maior preco", async () => {
    const orderRepository = {
      createOrder: vi.fn(async (data) => data),
    };

    const productRepository = {
      findSizePrice: vi
        .fn()
        .mockResolvedValueOnce({ price: 45.9 })
        .mockResolvedValueOnce({ price: 59.9 }),
    };

    const paymentRepository = {};

    const service = new OrderService(
      orderRepository,
      productRepository,
      paymentRepository,
    );

    const result = await service.createOrder({
      userId: "user-1",
      deliveryAddress: "Rua das Palmeiras, 123",
      items: [
        {
          type: "MEIO_A_MEIO",
          firstHalfProductId: "produto-a",
          secondHalfProductId: "produto-b",
          size: "GRANDE",
          quantity: 2,
        },
      ],
      paymentMethod: "pix",
    });

    expect(productRepository.findSizePrice).toHaveBeenCalledTimes(2);
    expect(Number(result.items.create[0].unitPrice)).toBe(59.9);
    expect(Number(result.items.create[0].totalPrice)).toBe(119.8);
    expect(Number(result.total)).toBe(119.8);
  });

  it("deve somar a borda recheada ao valor da pizza", async () => {
    const orderRepository = {
      createOrder: vi.fn(async (data) => data),
    };

    const productRepository = {
      findSizePrice: vi
        .fn()
        .mockResolvedValueOnce({ price: 52.9 })
        .mockResolvedValueOnce({ price: 8 }),
    };

    const service = new OrderService(orderRepository, productRepository, {});

    const result = await service.createOrder({
      userId: "user-1",
      deliveryAddress: "Rua das Palmeiras, 123",
      items: [
        {
          type: "INTEIRA",
          productId: "produto-a",
          crustProductId: "borda-a",
          size: "GRANDE",
          quantity: 1,
        },
      ],
      paymentMethod: "pix",
    });

    expect(productRepository.findSizePrice).toHaveBeenCalledTimes(2);
    expect(Number(result.items.create[0].crustUnitPrice)).toBe(8);
    expect(Number(result.items.create[0].unitPrice)).toBe(60.9);
    expect(Number(result.total)).toBe(60.9);
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
