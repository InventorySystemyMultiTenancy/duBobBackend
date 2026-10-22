import { describe, expect, it, vi } from "vitest";

vi.mock("../src/realtime/socketServer.js", () => ({
  emitPaymentUpdated: vi.fn(),
}));

import { SumUpPaymentService } from "../src/services/SumUpPaymentService.js";

const MINUTE = 60 * 1000;

function buildService({
  orders,
  transactions = [],
  checkouts = {},
  readerTransactions = {},
  knownExternalIds = [],
}) {
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
    getCheckout: vi.fn(async (id) => checkouts[id]),
    getTransactionByClientId: vi.fn(async (_mc, id) => readerTransactions[id] ?? null),
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

const checkoutIntent = (id, createdAt) => `sumup-checkout:${id}:${createdAt}`;

describe("SumUpPaymentService online (checkout)", () => {
  it("aprova o pedido quando o checkout está PAID com o mesmo valor", async () => {
    const { service, orderRepository, paymentRepository } = buildService({
      orders: [{ id: "A", total: "42.50", terminalIntentId: checkoutIntent("ck1", Date.now()) }],
      checkouts: {
        ck1: {
          id: "ck1",
          status: "PAID",
          amount: 42.5,
          transactions: [{ id: "tx9", status: "SUCCESSFUL" }],
        },
      },
    });

    expect(await service.syncAwaitingOrders()).toBe(1);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "APROVADO");
    expect(paymentRepository.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "sumup:tx9", provider: "SUMUP" }),
    );
  });

  it("não aprova checkout pago com valor diferente", async () => {
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "42.50", terminalIntentId: checkoutIntent("ck1", Date.now()) }],
      checkouts: { ck1: { id: "ck1", status: "PAID", amount: 1 } },
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it("recusa o pedido quando o checkout expira", async () => {
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "10.00", terminalIntentId: checkoutIntent("ck1", Date.now()) }],
      checkouts: { ck1: { id: "ck1", status: "EXPIRED", amount: 10 } },
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "RECUSADO");
  });
});

describe("SumUpPaymentService cobrança enviada ao reader", () => {
  const readerIntent = (sentAt, ctid) => `sumup-user:t@x.com:${sentAt}:rdr_1:${ctid}`;

  it("aprova pela consulta do client_transaction_id", async () => {
    const { service, orderRepository, paymentRepository } = buildService({
      orders: [{ id: "A", total: "18.00", terminalIntentId: readerIntent(Date.now(), "ct1") }],
      readerTransactions: { ct1: { id: "tx5", status: "SUCCESSFUL", amount: 18 } },
    });

    expect(await service.syncAwaitingOrders()).toBe(1);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "APROVADO");
    expect(paymentRepository.upsertFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "sumup:tx5" }),
    );
  });

  it("recusa quando a venda falha na maquininha", async () => {
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "18.00", terminalIntentId: readerIntent(Date.now(), "ct1") }],
      readerTransactions: { ct1: { id: "tx5", status: "FAILED", amount: 18 } },
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).toHaveBeenCalledWith("A", "RECUSADO");
  });

  it("enquanto não paga, continua aguardando", async () => {
    const { service, orderRepository } = buildService({
      orders: [{ id: "A", total: "18.00", terminalIntentId: readerIntent(Date.now(), "ct1") }],
    });

    expect(await service.syncAwaitingOrders()).toBe(0);
    expect(orderRepository.updatePaymentStatus).not.toHaveBeenCalled();
  });
});

describe("SumUpPaymentService maquininha escolhida no totem", () => {
  const operator = { id: "op1", name: "Totem1", email: "maq.1@dubob.com.br", readerId: null };
  const operatorRepository = {
    findAll: vi.fn().mockResolvedValue([operator]),
    findById: vi.fn(async (id) => (id === "op1" ? operator : null)),
  };
  const orderRepository = { saveTerminalIntentId: vi.fn() };

  it("cobra na maquininha pelo id e marca o pedido com o usuário dela", async () => {
    const service = new SumUpPaymentService(orderRepository, {}, operatorRepository, {});
    const result = await service.startTerminalChargeForOperator(
      { id: "pedido123456", total: "12.00", terminalIntentId: null },
      "op1",
    );

    expect(result.terminalName).toBe("Totem1");
    expect(orderRepository.saveTerminalIntentId).toHaveBeenCalledWith(
      "pedido123456",
      expect.stringMatching(/^sumup-user:maq\.1@dubob\.com\.br:\d+$/),
    );
  });

  it("avisa quando a maquininha escolhida foi removida", async () => {
    const service = new SumUpPaymentService(orderRepository, {}, operatorRepository, {});
    await expect(
      service.startTerminalChargeForOperator({ id: "p", total: "1.00" }, "sumiu"),
    ).rejects.toThrow(/não existe mais/);
  });
});
