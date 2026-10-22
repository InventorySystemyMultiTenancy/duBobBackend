import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import { PaymentSettingsService } from "./PaymentSettingsService.js";
import { emitPaymentUpdated } from "../realtime/socketServer.js";

// Maquininha Stone (Stone Connect 2.0). O pedido vai para a tela da
// maquininha pelo serial dela e o status vem sempre da consulta do pedido na
// API: o webhook só avisa que vale a pena consultar antes da hora.
//   Order.terminalIntentId: "stone:<orderIdStone>:<enviadoEmMs>"
const INTENT_PREFIX = "stone:";

// A doc avisa que a consulta de pedido tem limite: intervalo mais folgado
// que o da SumUp e só enquanto houver pedido aguardando.
const POLL_INTERVAL_MS =
  Number(process.env.STONE_POLL_INTERVAL_SECONDS || 15) * 1000;
const AWAITING_WINDOW_MS = 15 * 60 * 1000;

let pollTimer = null;
let polling = false;

const toCents = (value) => Math.round(Number(value) * 100);

export const isStoneIntent = (intentId) =>
  String(intentId ?? "").startsWith(INTENT_PREFIX);

export const parseStoneIntent = (intentId) => {
  if (!isStoneIntent(intentId)) return null;
  const [stoneOrderId, sentAt] = intentId.slice(INTENT_PREFIX.length).split(":");
  return { stoneOrderId, sentAt: Number(sentAt) || 0 };
};

// Pago quando os charges pagos cobrem o valor do pedido (no pedido direto a
// Stone só aceita o valor cheio; na lista pode vir em mais de um cartão).
const paidCharges = (stoneOrder) =>
  (stoneOrder?.charges ?? []).filter(
    (charge) => String(charge.status ?? "").toLowerCase() === "paid",
  );

export const isStoneOrderPaid = (stoneOrder, totalCents) => {
  if (String(stoneOrder?.status ?? "").toLowerCase() === "paid") return true;
  const paid = paidCharges(stoneOrder).reduce(
    (sum, charge) => sum + Number(charge.paid_amount ?? charge.amount ?? 0),
    0,
  );
  return paid > 0 && paid >= totalCents;
};

export class StonePaymentService {
  constructor(
    orderRepository = new OrderRepository(),
    paymentRepository = new PaymentRepository(),
    paymentSettingsService = new PaymentSettingsService(),
  ) {
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
    this.paymentSettingsService = paymentSettingsService;
  }

  async startTerminalCharge(order, serialNumber, displayName) {
    const serial = String(serialNumber ?? "").trim();
    if (!serial) throw new AppError("Local sem maquininha Stone configurada.", 422);

    const { client, paymentType } = await this.paymentSettingsService.requireStoneClient();

    // Pedido anterior ainda aberto na maquininha: tira da tela antes.
    await this.cancelTerminalCharge(order);

    const shortId = order.id.slice(-6).toUpperCase();
    const stoneOrder = await client.createTerminalOrder({
      amountCents: toCents(order.total),
      code: `${order.id.slice(-10)}${Date.now().toString(36)}`.slice(0, 52),
      description: `Pedido Dubob #${shortId}`,
      displayName: displayName || `Pedido #${shortId}`,
      serialNumber: serial,
      paymentType,
    });
    if (!stoneOrder?.id) throw new AppError("A Stone não criou o pedido.", 502);

    await this.orderRepository.saveTerminalIntentId(
      order.id,
      `${INTENT_PREFIX}${stoneOrder.id}:${Date.now()}`,
    );
    console.log(`[Stone] Pedido ${stoneOrder.id} enviado à maquininha ${serial} -> ${order.id}`);
    this.ensurePolling();

    return { provider: "STONE", intentId: stoneOrder.id, deviceId: serial, status: "sent" };
  }

  // Tira o pedido da maquininha. Devolve false se não deu para garantir que
  // ele saiu (aí o pedido do duBob não deve ser cancelado).
  async cancelTerminalCharge(order) {
    const intent = parseStoneIntent(order.terminalIntentId);
    if (!intent) return true;
    try {
      const { client } = await this.paymentSettingsService.requireStoneClient();
      await client.closeOrder(intent.stoneOrderId, "canceled");
      return true;
    } catch (error) {
      // 4xx = pedido já fechado (pago, cancelado ou expirado na Stone).
      const alreadyClosed = error.providerStatus >= 400 && error.providerStatus < 500;
      if (!alreadyClosed) console.warn("[Stone] cancelamento falhou:", error.message);
      return alreadyClosed;
    }
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
      console.warn("[Stone poller] Falha:", error.message);
    } finally {
      polling = false;
    }
  }

  // Devolve quantos pedidos foram aprovados, ou null se não há nada aguardando.
  async syncAwaitingOrders() {
    const now = Date.now();
    const awaiting = (await this.orderRepository.findAwaitingStoneOrders())
      .map((order) => ({ ...order, intent: parseStoneIntent(order.terminalIntentId) }))
      .filter((order) => order.intent && now - order.intent.sentAt < AWAITING_WINDOW_MS);
    if (!awaiting.length) return null;

    const { client } = await this.paymentSettingsService.requireStoneClient();
    let matched = 0;
    for (const order of awaiting) {
      if (await this.#syncOrder(client, order)) matched += 1;
    }
    return matched;
  }

  // Webhook charge.paid: o corpo não é confiado, só diz qual pedido consultar.
  async handleWebhook(body) {
    const stoneOrderId = String(body?.data?.order?.id ?? "").trim();
    if (!stoneOrderId) return { ignored: true };

    const order = await this.orderRepository.findByTerminalIntentPrefix(
      `${INTENT_PREFIX}${stoneOrderId}:`,
    );
    if (!order || order.paymentStatus !== "PENDENTE") return { ignored: true };

    const { client } = await this.paymentSettingsService.requireStoneClient();
    const approved = await this.#syncOrder(client, {
      ...order,
      intent: parseStoneIntent(order.terminalIntentId),
    });
    return { orderId: order.id, approved };
  }

  async #syncOrder(client, order) {
    const stoneOrder = await client.getOrder(order.intent.stoneOrderId);
    const status = String(stoneOrder?.status ?? "").toLowerCase();

    if (isStoneOrderPaid(stoneOrder, toCents(order.total))) {
      const charge = paidCharges(stoneOrder)[0];
      const externalId = `stone:${charge?.id ?? stoneOrder.id}`;
      if (await this.paymentRepository.existsByExternalId(externalId)) return false;

      await this.paymentRepository.upsertFromWebhook({
        orderId: order.id,
        provider: "STONE",
        externalId,
        status: "APROVADO",
        payload: stoneOrder,
        amount: order.total,
      });
      await this.orderRepository.updatePaymentStatus(order.id, "APROVADO");
      emitPaymentUpdated({ orderId: order.id, userId: order.userId, paymentStatus: "APROVADO" });
      console.log(`[Stone poller] ✅ Pedido ${order.id} aprovado (${externalId})`);

      // Obrigatório fechar depois de pago, senão a maquininha trava a lista.
      if (status !== "paid") {
        await client.closeOrder(stoneOrder.id, "paid").catch((error) =>
          console.warn(`[Stone] Não foi possível fechar o pedido ${stoneOrder.id}:`, error.message),
        );
      }
      return true;
    }

    if (status === "canceled" || status === "failed") {
      await this.orderRepository.updatePaymentStatus(order.id, "RECUSADO");
      emitPaymentUpdated({ orderId: order.id, userId: order.userId, paymentStatus: "RECUSADO" });
      console.log(`[Stone] Pedido ${order.id} RECUSADO (pedido Stone ${status})`);
    }
    return false;
  }
}
