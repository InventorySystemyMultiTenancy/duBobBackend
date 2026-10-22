import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import { SumUpOperatorRepository } from "../repositories/SumUpOperatorRepository.js";
import { PaymentSettingsService } from "./PaymentSettingsService.js";
import { emitPaymentUpdated } from "../realtime/socketServer.js";

// Igual ao CompactPay: nem o ID do reader nem o webhook são confiáveis, então
// cada maquininha fica logada com um usuário SumUp próprio e consultamos o
// histórico de vendas. Uma venda aprovada é do pedido que está aguardando
// naquela maquininha (mesmo usuário) com o mesmo valor.
//
// Order.terminalIntentId de pedidos aguardando: "sumup-user:<email>:<enviadoEmMs>".
const INTENT_PREFIX = "sumup-user:";

const POLL_INTERVAL_MS =
  Number(process.env.SUMUP_POLL_INTERVAL_SECONDS || 10) * 1000;
// Depois disso o pedido deixa de ser casado automaticamente.
const AWAITING_WINDOW_MS = 30 * 60 * 1000;
// Folga no changes_since para vendas que demoram a aparecer no histórico.
const CHANGES_SINCE_MARGIN_MS = 5 * 60 * 1000;
// Venda feita um pouco antes de o pedido chegar na tela (relógios diferentes).
const CLOCK_SKEW_MS = 2 * 60 * 1000;

let pollTimer = null;
let polling = false;

const toCents = (value) => Math.round(Number(value) * 100);
const toSumUpDate = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export const isSumUpIntent = (intentId) =>
  String(intentId ?? "").startsWith(INTENT_PREFIX);

export const parseSumUpIntent = (intentId) => {
  if (!isSumUpIntent(intentId)) return null;
  const rest = intentId.slice(INTENT_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  return {
    email: rest.slice(0, separator).toLowerCase(),
    sentAt: Number(rest.slice(separator + 1)) || 0,
  };
};

export class SumUpPaymentService {
  constructor(
    orderRepository = new OrderRepository(),
    paymentRepository = new PaymentRepository(),
    sumUpOperatorRepository = new SumUpOperatorRepository(),
    paymentSettingsService = new PaymentSettingsService(),
  ) {
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
    this.sumUpOperatorRepository = sumUpOperatorRepository;
    this.paymentSettingsService = paymentSettingsService;
  }

  // Marca o pedido como "aguardando na maquininha <usuário>". A cobrança é
  // digitada na própria maquininha; o poller confirma quando a venda aparecer.
  async startTerminalCharge(order, operatorEmail) {
    const email = String(operatorEmail ?? "").trim().toLowerCase();
    const operators = await this.sumUpOperatorRepository.findAll();
    const operator = operators.find((item) => item.email === email);
    if (!operator) {
      throw new AppError(
        "A maquininha deste local não é um usuário SumUp cadastrado em Admin → Pagamentos.",
        422,
      );
    }

    await this.orderRepository.saveTerminalIntentId(
      order.id,
      `${INTENT_PREFIX}${email}:${Date.now()}`,
    );
    console.log(`[SumUp] Pedido ${order.id} aguardando na maquininha ${email}`);
    this.ensurePolling();

    return {
      provider: "SUMUP",
      mode: "manual",
      deviceId: email,
      terminalName: operator.name,
      amount: Number(order.total).toFixed(2),
      status: "waiting",
    };
  }

  ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }

  #stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async #tick() {
    if (polling) return;
    polling = true;
    try {
      const matched = await this.syncAwaitingOrders();
      if (matched === null) this.#stopPolling();
    } catch (error) {
      console.warn("[SumUp poller] Falha:", error.message);
    } finally {
      polling = false;
    }
  }

  // Devolve quantos pedidos foram aprovados, ou null se não há nada aguardando.
  async syncAwaitingOrders() {
    const now = Date.now();
    const awaiting = (await this.orderRepository.findAwaitingSumUpOrders())
      .map((order) => ({ ...order, intent: parseSumUpIntent(order.terminalIntentId) }))
      .filter((order) => order.intent && now - order.intent.sentAt < AWAITING_WINDOW_MS);
    if (!awaiting.length) return null;

    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    const oldestSentAt = Math.min(...awaiting.map((order) => order.intent.sentAt));
    const transactions = await client.listSuccessfulTransactions(
      merchantCode,
      toSumUpDate(oldestSentAt - CHANGES_SINCE_MARGIN_MS),
    );

    let matched = 0;
    for (const transaction of transactions) {
      if (String(transaction.status ?? "").toUpperCase() !== "SUCCESSFUL") continue;
      const transactionId = String(transaction.id ?? transaction.transaction_id ?? "");
      if (!transactionId) continue;
      const externalId = `sumup:${transactionId}`;
      if (await this.paymentRepository.existsByExternalId(externalId)) continue;

      const order = this.#matchOrder(awaiting, transaction);
      if (!order) {
        console.log(
          `[SumUp poller] Venda ${transactionId} (R$ ${transaction.amount}, usuário ${transaction.user}) sem pedido aguardando.`,
        );
        continue;
      }

      await this.#approve(order, externalId, transaction);
      awaiting.splice(awaiting.indexOf(order), 1);
      matched += 1;
    }
    return matched;
  }

  #matchOrder(awaiting, transaction) {
    const user = String(transaction.user ?? "").trim().toLowerCase();
    const amountCents = toCents(transaction.amount);
    const paidAt = Date.parse(transaction.timestamp ?? "") || Date.now();

    // Mesma maquininha, mesmo valor e venda feita depois do pedido ir para a
    // maquininha. Com mais de um candidato, fica o que chegou por último antes da venda.
    return awaiting
      .filter(
        (order) =>
          order.intent.email === user &&
          toCents(order.total) === amountCents &&
          order.intent.sentAt - CLOCK_SKEW_MS <= paidAt,
      )
      .sort((a, b) => b.intent.sentAt - a.intent.sentAt)[0];
  }

  async #approve(order, externalId, transaction) {
    await this.paymentRepository.upsertFromWebhook({
      orderId: order.id,
      provider: "SUMUP",
      externalId,
      status: "APROVADO",
      payload: transaction,
      amount: order.total,
    });
    await this.orderRepository.updatePaymentStatus(order.id, "APROVADO");
    emitPaymentUpdated({
      orderId: order.id,
      userId: order.userId,
      paymentStatus: "APROVADO",
    });
    console.log(
      `[SumUp poller] ✅ Pedido ${order.id} aprovado pela venda ${externalId} (${order.intent.email})`,
    );
  }
}
