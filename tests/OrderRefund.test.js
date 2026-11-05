import { describe, expect, it, vi, beforeEach } from "vitest";

const refundCreateMock = vi.fn();

vi.mock("mercadopago", () => ({
  MercadoPagoConfig: vi.fn(),
  Payment: vi.fn(),
  PaymentRefund: vi.fn().mockImplementation(() => ({
    create: refundCreateMock,
  })),
}));

vi.mock("../src/realtime/socketServer.js", () => ({
  emitOrderCreated: vi.fn(),
  emitMotoboyLocation: vi.fn(),
  emitOrderStatusUpdated: vi.fn(),
  emitPaymentUpdated: vi.fn(),
}));

import { OrderService, getRefundInfo } from "../src/services/OrderService.js";
import {
  emitOrderStatusUpdated,
  emitPaymentUpdated,
} from "../src/realtime/socketServer.js";

const pedidoPago = (overrides = {}) => ({
  id: "order-1",
  userId: "u1",
  status: "PREPARANDO",
  paymentStatus: "APROVADO",
  total: 42.5,
  terminalIntentId: null,
  externalSource: null,
  payment: { provider: "MERCADO_PAGO", externalId: "155356274197" },
  ...overrides,
});

const montar = (order, { sumUpClient } = {}) => {
  const orderRepository = {
    findById: vi.fn(async () => order),
    updateStatus: vi.fn(async (id, status) => ({ ...order, id, status })),
    updatePaymentStatus: vi.fn(async () => ({})),
    mergeExternalPayload: vi.fn(async () => {}),
  };
  const paymentRepository = { updateStatus: vi.fn(async () => ({})) };
  const paymentSettingsService = {
    requireSumUpClient: vi.fn(async () => ({ client: sumUpClient })),
  };
  const service = new OrderService(
    orderRepository,
    {},
    paymentRepository,
    {},
    paymentSettingsService,
  );
  return { service, orderRepository, paymentRepository };
};

describe("cancelar pedido com estorno", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MP_ACCESS_TOKEN = "token-teste";
  });

  it("estorna o PIX/cartão do Mercado Pago e grava ESTORNADO", async () => {
    refundCreateMock.mockResolvedValue({ id: 9876, status: "approved" });
    const { service, orderRepository, paymentRepository } = montar(pedidoPago());

    const result = await service.cancelOrder("order-1", {
      motivo: "Acabou o açaí",
      user: { email: "cozinha@dubob.com" },
    });

    expect(refundCreateMock).toHaveBeenCalledWith({
      payment_id: "155356274197",
      requestOptions: { idempotencyKey: "cancel-order-1" },
    });
    expect(paymentRepository.updateStatus).toHaveBeenCalledWith("order-1", "ESTORNADO");
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("order-1", "ESTORNADO");
    expect(orderRepository.updateStatus).toHaveBeenCalledWith("order-1", "CANCELADO");
    expect(orderRepository.mergeExternalPayload).toHaveBeenCalledWith("order-1", {
      cancelamentoLoja: expect.objectContaining({
        motivo: "Acabou o açaí",
        por: "cozinha@dubob.com",
        estorno: { tipo: "AUTOMATICO", provedor: "MERCADO_PAGO", id: "9876", valor: 42.5 },
      }),
    });
    expect(emitOrderStatusUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order-1", status: "CANCELADO" }),
    );
    expect(emitPaymentUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order-1", paymentStatus: "ESTORNADO" }),
    );
    expect(result.status).toBe("CANCELADO");
    expect(result.paymentStatus).toBe("ESTORNADO");
  });

  it("se o estorno falhar o pedido não é cancelado", async () => {
    refundCreateMock.mockRejectedValue({
      message: "bad_request",
      cause: [{ description: "Payment too old to be refunded" }],
    });
    const { service, orderRepository, paymentRepository } = montar(pedidoPago());

    await expect(service.cancelOrder("order-1", { motivo: "x" })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("Payment too old to be refunded"),
    });
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
    expect(paymentRepository.updateStatus).not.toHaveBeenCalled();
    expect(emitOrderStatusUpdated).not.toHaveBeenCalled();
  });

  it("estorna o checkout online da SumUp pela transação", async () => {
    const sumUpClient = { refundTransaction: vi.fn(async () => ({})) };
    const { service, orderRepository } = montar(
      pedidoPago({
        terminalIntentId: "sumup-checkout:chk-1:1730000000000",
        payment: { provider: "SUMUP", externalId: "sumup:txn-abc" },
      }),
      { sumUpClient },
    );

    const result = await service.cancelOrder("order-1", { motivo: "Loja fechada" });

    expect(sumUpClient.refundTransaction).toHaveBeenCalledWith("txn-abc");
    expect(refundCreateMock).not.toHaveBeenCalled();
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("order-1", "ESTORNADO");
    expect(result.estorno).toMatchObject({ tipo: "AUTOMATICO", provedor: "SUMUP" });
  });

  it("dinheiro e maquininha cancelam sem estorno automático", async () => {
    const { service, orderRepository } = montar(
      pedidoPago({ paymentMethod: "DINHEIRO", payment: null }),
    );

    const result = await service.cancelOrder("order-1", { motivo: "Cliente desistiu" });

    expect(refundCreateMock).not.toHaveBeenCalled();
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
    expect(orderRepository.updateStatus).toHaveBeenCalledWith("order-1", "CANCELADO");
    expect(result.estorno).toEqual({ tipo: "MANUAL", provedor: null });
    expect(emitPaymentUpdated).not.toHaveBeenCalled();
  });

  it("pedido ainda não pago cancela sem estorno", async () => {
    const { service } = montar(pedidoPago({ paymentStatus: "PENDENTE" }));
    const result = await service.cancelOrder("order-1");
    expect(refundCreateMock).not.toHaveBeenCalled();
    expect(result.estorno).toBeNull();
  });
});

describe("getRefundInfo", () => {
  it("maquininha do Mercado Pago é estorno manual", () => {
    expect(
      getRefundInfo(pedidoPago({ terminalIntentId: "ORD01KPXW3PVAVJTCF7H2JEB4GZSK" })),
    ).toEqual({ tipo: "MANUAL", provedor: "MERCADO_PAGO" });
  });

  it("maquininha da SumUp é estorno manual", () => {
    expect(
      getRefundInfo(
        pedidoPago({
          terminalIntentId: "sumup-user:caixa@dubob.com:1730000000000",
          payment: { provider: "SUMUP", externalId: "sumup:txn-1" },
        }),
      ),
    ).toEqual({ tipo: "MANUAL", provedor: "SUMUP" });
  });

  it("pedido do iFood não entra (o iFood estorna)", () => {
    expect(getRefundInfo(pedidoPago({ externalSource: "IFOOD" }))).toBeNull();
  });
});
