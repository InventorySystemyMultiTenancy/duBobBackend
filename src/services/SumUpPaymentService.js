import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import { PaymentSettingsService } from "./PaymentSettingsService.js";
import { emitPaymentUpdated } from "../realtime/socketServer.js";

// Pedido.terminalIntentId de cobranças SumUp: "sumup:<readerId>:<clientTransactionId>".
// O prefixo separa das orders do Mercado Pago e guarda o reader para o terminate.
const INTENT_PREFIX = "sumup:";

const STATUS_MAP = {
  SUCCESSFUL: "APROVADO",
  FAILED: "RECUSADO",
  CANCELLED: "RECUSADO",
  REFUNDED: "ESTORNADO",
};

// O webhook da SumUp pode não chegar (servidor dormindo, rede); por isso
// também consultamos a transação por alguns minutos depois de criar a cobrança.
const WATCH_INTERVAL_MS = 5000;
const WATCH_TIMEOUT_MS = 4 * 60 * 1000;
const watchers = new Map();

export const isSumUpIntent = (intentId) =>
  String(intentId ?? "").startsWith(INTENT_PREFIX);

export const parseSumUpIntent = (intentId) => {
  if (!isSumUpIntent(intentId)) return null;
  const [readerId, ...rest] = intentId.slice(INTENT_PREFIX.length).split(":");
  return { readerId, clientTransactionId: rest.join(":") };
};

export class SumUpPaymentService {
  constructor(
    orderRepository = new OrderRepository(),
    paymentRepository = new PaymentRepository(),
    paymentSettingsService = new PaymentSettingsService(),
  ) {
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
    this.paymentSettingsService = paymentSettingsService;
  }

  async startTerminalCheckout(order, readerId, description) {
    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();

    // Cobrança anterior ainda aberta na maquininha: encerra antes de mandar outra.
    if (order.terminalIntentId) {
      await this.cancelTerminalCheckout(order).catch((e) =>
        console.warn("[SumUp] Não foi possível encerrar cobrança anterior:", e.message),
      );
    }

    const backendUrl = process.env.BACKEND_URL || "https://dubobbackend.onrender.com";
    const { clientTransactionId } = await client.createReaderCheckout(
      merchantCode,
      readerId,
      {
        amount: order.total,
        description,
        returnUrl: `${backendUrl}/api/payments/sumup/webhook`,
      },
    );

    const intentId = `${INTENT_PREFIX}${readerId}:${clientTransactionId}`;
    await this.orderRepository.saveTerminalIntentId(order.id, intentId);
    console.log("[SumUp] Cobrança enviada:", intentId, "-> pedido", order.id);

    this.#watch(order.id, intentId);

    return { intentId, deviceId: readerId, status: "pending" };
  }

  async cancelTerminalCheckout(order) {
    const intent = parseSumUpIntent(order.terminalIntentId);
    if (!intent) return;
    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    this.#stopWatch(order.id);
    await client.terminateReaderCheckout(merchantCode, intent.readerId);
  }

  // Cancelamento pedido pelo cliente no totem. Devolve false se a cobrança
  // pode continuar aberta na maquininha (aí o pedido não deve ser cancelado);
  // se já foi paga, o controller barra pelo paymentStatus atualizado.
  async tryCancelBeforeOrderCancel(order) {
    try {
      await this.cancelTerminalCheckout(order);
    } catch (error) {
      // 4xx = maquininha sem cobrança aberta (já expirou/foi cancelada nela).
      const nothingOpen = error.providerStatus >= 400 && error.providerStatus < 500;
      if (!nothingOpen) {
        console.warn("[SumUp] terminate falhou:", error.message);
        return false;
      }
    }
    await this.syncOrder(order.id, order.terminalIntentId).catch(() => null);
    return true;
  }

  // Consulta a SumUp e grava o status no pedido. Devolve o paymentStatus.
  async syncOrder(orderId, intentId) {
    const intent = parseSumUpIntent(intentId);
    if (!intent) return null;

    const order = await this.orderRepository.findById(orderId);
    if (!order || order.terminalIntentId !== intentId) return null;
    if (order.paymentStatus === "APROVADO") return "APROVADO";

    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    const transaction = await client.getTransactionByClientId(
      merchantCode,
      intent.clientTransactionId,
    );
    const paymentStatus = STATUS_MAP[String(transaction?.status ?? "").toUpperCase()];
    if (!paymentStatus) return "PENDENTE";

    await this.paymentRepository.upsertFromWebhook({
      orderId,
      provider: "SUMUP",
      externalId: transaction.id ? `sumup:${transaction.id}` : null,
      status: paymentStatus,
      payload: transaction,
      amount: order.total,
    });
    await this.orderRepository.updatePaymentStatus(orderId, paymentStatus);
    emitPaymentUpdated({ orderId, userId: order.userId, paymentStatus });
    console.log(`[SumUp] ✅ Pedido ${orderId} -> paymentStatus=${paymentStatus}`);

    return paymentStatus;
  }

  async handleWebhook(body) {
    const clientTransactionId = String(
      body?.payload?.client_transaction_id ?? body?.id ?? "",
    ).trim();
    if (!clientTransactionId) return { ignored: true };

    const order =
      await this.orderRepository.findBySumUpClientTransactionId(clientTransactionId);
    if (!order) {
      console.warn("[SumUp webhook] Cobrança desconhecida:", clientTransactionId);
      return { ignored: true };
    }

    const paymentStatus = await this.syncOrder(order.id, order.terminalIntentId);
    if (paymentStatus && paymentStatus !== "PENDENTE") this.#stopWatch(order.id);
    return { orderId: order.id, paymentStatus };
  }

  #watch(orderId, intentId) {
    this.#stopWatch(orderId);
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
        this.#stopWatch(orderId);
        return;
      }
      try {
        const status = await this.syncOrder(orderId, intentId);
        if (status !== "PENDENTE") this.#stopWatch(orderId);
      } catch (e) {
        console.warn("[SumUp] Falha ao consultar cobrança:", e.message);
      }
    }, WATCH_INTERVAL_MS);
    timer.unref?.();
    watchers.set(orderId, timer);
  }

  #stopWatch(orderId) {
    clearInterval(watchers.get(orderId));
    watchers.delete(orderId);
  }
}
