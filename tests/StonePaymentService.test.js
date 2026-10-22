import { describe, expect, it, vi } from "vitest";

vi.mock("../src/realtime/socketServer.js", () => ({
  emitPaymentUpdated: vi.fn(),
}));

import {
  StonePaymentService,
  isStoneOrderPaid,
} from "../src/services/StonePaymentService.js";

function buildService({ orders = [], stoneOrders = {}, knownExternalIds = [], paymentType = null }) {
  const orderRepository = {
    findAwaitingStoneOrders: vi.fn().mockResolvedValue(orders),
    findByTerminalIntentPrefix: vi.fn(async (prefix) =>
      orders.find((order) => order.terminalIntentId.startsWith(prefix)) ?? null,
    ),
    updatePaymentStatus: vi.fn(),
    saveTerminalIntentId: vi.fn(),
  };
  const paymentRepository = {
    existsByExternalId: vi.fn(async (id) => knownExternalIds.includes(id)),
    upsertFromWebhook: vi.fn(),
  };
  const client = {
    createTerminalOrder: vi.fn().mockResolvedValue({ id: "or_novo", status: "pending" }),
    getOrder: vi.fn(async (id) => stoneOrders[id]),
    closeOrder: vi.fn().mockResolvedValue({}),
  };
  const paymentSettingsService = {
    requireStoneClient: vi.fn().mockResolvedValue({ client, paymentType }),
  };
  const service = new StonePaymentService(orderRepository, paymentRepository, paymentSettingsService);
  return { service, orderRepository, paymentRepository, client };
}

const intent = (stoneOrderId, sentAt = Date.now()) => `stone:${stoneOrderId}:${sentAt}`;

describe("StonePaymentService", () => {
  it("envia o pedido para a maquininha pelo serial, em centavos", async () => {
    const { service, client, orderRepository } = buildService({ paymentType: "debit" });

    const result = await service.startTerminalCharge(
      { id: "pedido123456", total: "25.90", terminalIntentId: null },
      "SN123",
      "Totem 1 #123456",
    );

    expect(client.createTerminalOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 2590,
        serialNumber: "SN123",
        displayName: "Totem 1 #123456",
        paymentType: "debit",
      }),
    );
    expect(orderRepository.saveTerminalIntentId).toHaveBeenCalledWith(
      "pedido123456",
      expect.stringMatching(/^stone:or_novo:\d+$/),
    );
    expect(result.status).toBe("sent");
  });

  it("tira da maquininha o pedido anterior antes de mandar outro", async () => {
    const { service, client } = buildService({});

    await service.startTerminalCharge(
      { id: "pedido123456", total: "10.00", terminalIntentId: intent("or_velho") },
      "SN123",
    );

    expect(client.closeOrder).toHaveBeenCalledWith("or_velho", "canceled");
  });

  it("aprova quando o charge pago cobre o pedido e fecha o pedido na Stone", async () => {
    const { service, orderRepository, paymentRepository, client } = buildService({
      orders: [{ id: "A", total: "25.90", terminalIntentId: intent("or_1") }],
      stoneOrders: {
        or_1: { id: "or_1", status: "pending", charges: [{ id: "ch_1", status: "paid", paid_amount: 2590 }] },
      },
    });

    expect(await service.syncAwaitingOrders()).toBe(1);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "APROVADO");
    expect(paymentRepository.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "stone:ch_1", provider: "STONE" }),
    );
    expect(client.closeOrder).toHaveBeenCalledWith("or_1", "paid");
  });

  it("não aprova pagamento parcial nem pedido ainda pendente", async () => {
    const { service, orderRepository } = buildService({
      orders: [
        { id: "A", total: "25.90", terminalIntentId: intent("or_1") },
        { id: "B", total: "10.00", terminalIntentId: intent("or_2") },
      ],
      stoneOrders: {
        or_1: { id: "or_1", status: "pending", charges: [{ id: "ch_1", status: "paid", paid_amount: 1000 }] },
        or_2: { id: "or_2", status: "pending", charges: [] },
      },
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("recusa quando o pedido foi cancelado na Stone", async () => {
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "10.00", terminalIntentId: intent("or_1") }],
      stoneOrders: { or_1: { id: "or_1", status: "canceled", charges: [] } },
    });

    await service.syncAwaitingOrders();
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "RECUSADO");
  });

  it("webhook só dispara a consulta: corpo dizendo pago não aprova sozinho", async () => {
    const { service, orderRepository, client } = buildService({
      orders: [{ id: "A", total: "10.00", paymentStatus: "PENDENTE", terminalIntentId: intent("or_1") }],
      stoneOrders: { or_1: { id: "or_1", status: "pending", charges: [] } },
    });

    const result = await service.handleWebhook({
      type: "charge.paid",
      data: { status: "paid", amount: 1000, order: { id: "or_1" } },
    });

    expect(client.getOrder).toHaveBeenCalledWith("or_1");
    expect(result.approved).toBe(false);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("devolve null quando não há nada aguardando (para o poller parar)", async () => {
    const { service } = buildService({
      orders: [{ id: "A", total: "10.00", terminalIntentId: intent("or_1", Date.now() - 60 * 60 * 1000) }],
    });

    expect(await service.syncAwaitingOrders()).toBeNull();
  });

  it("isStoneOrderPaid soma charges pagos (lista em mais de um cartão)", () => {
    expect(
      isStoneOrderPaid(
        { status: "pending", charges: [{ status: "paid", paid_amount: 600 }, { status: "paid", paid_amount: 400 }] },
        1000,
      ),
    ).toBe(true);
    expect(isStoneOrderPaid({ status: "pending", charges: [{ status: "failed", amount: 1000 }] }, 1000)).toBe(false);
  });
});
