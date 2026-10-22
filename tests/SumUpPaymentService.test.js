import { describe, expect, it, vi } from "vitest";

vi.mock("../src/realtime/socketServer.js", () => ({
  emitPaymentUpdated: vi.fn(),
}));

import { SumUpPaymentService } from "../src/services/SumUpPaymentService.js";

const MINUTE = 60 * 1000;

function buildService({ orders, transactions, knownExternalIds = [] }) {
  const orderRepository = {
    findAwaitingSumUpOrders: vi.fn().mockResolvedValue(orders),
    updatePaymentStatus: vi.fn(),
    saveTerminalIntentId: vi.fn(),
  };
  const paymentRepository = {
    existsByExternalId: vi.fn(async (id) => knownExternalIds.includes(id)),
    upsertFromWebhook: vi.fn(),
  };
  const client = {
    listSuccessfulTransactions: vi.fn().mockResolvedValue(transactions),
  };
  const paymentSettingsService = {
    requireSumUpClient: vi.fn().mockResolvedValue({ client, merchantCode: "MC1" }),
  };
  const service = new SumUpPaymentService(
    orderRepository,
    paymentRepository,
    { findAll: vi.fn().mockResolvedValue([]) },
    paymentSettingsService,
  );
  return { service, orderRepository, paymentRepository };
}

const intent = (email, sentAt) => `sumup-user:${email}:${sentAt}`;

describe("SumUpPaymentService.syncAwaitingOrders", () => {
  it("aprova o pedido da mesma maquininha com o mesmo valor", async () => {
    const now = Date.now();
    const { service, orderRepository } = buildService({
      orders: [
        { id: "A", total: "25.00", terminalIntentId: intent("totem1@x.com", now - MINUTE) },
        { id: "B", total: "25.00", terminalIntentId: intent("mesa3@x.com", now - MINUTE) },
      ],
      transactions: [
        {
          id: "tx1",
          status: "SUCCESSFUL",
          amount: 25,
          user: "MESA3@x.com",
          timestamp: new Date(now).toISOString(),
        },
      ],
    });

    expect(await service.syncAwaitingOrders()).toBe(1);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("B", "APROVADO");
  });

  it("não aprova com valor diferente, outro usuário ou venda já usada", async () => {
    const now = Date.now();
    const { service, orderRepository } = buildService({
      orders: [
        { id: "A", total: "25.00", terminalIntentId: intent("totem1@x.com", now - MINUTE) },
      ],
      transactions: [
        { id: "tx1", status: "SUCCESSFUL", amount: 24.99, user: "totem1@x.com" },
        { id: "tx2", status: "SUCCESSFUL", amount: 25, user: "outro@x.com" },
        { id: "tx3", status: "SUCCESSFUL", amount: 25, user: "totem1@x.com" },
      ],
      knownExternalIds: ["sumup:tx3"],
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("ignora venda feita antes de o pedido ir para a maquininha", async () => {
    const now = Date.now();
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "10.00", terminalIntentId: intent("t@x.com", now) }],
      transactions: [
        {
          id: "tx1",
          status: "SUCCESSFUL",
          amount: 10,
          user: "t@x.com",
          timestamp: new Date(now - 10 * MINUTE).toISOString(),
        },
      ],
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("devolve null quando não há pedido aguardando (para o poller parar)", async () => {
    const { service } = buildService({
      orders: [
        { id: "A", total: "10.00", terminalIntentId: intent("t@x.com", Date.now() - 60 * MINUTE) },
      ],
      transactions: [],
    });

    expect(await service.syncAwaitingOrders()).toBeNull();
  });
});
