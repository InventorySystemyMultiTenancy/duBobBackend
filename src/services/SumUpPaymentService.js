import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import { SumUpOperatorRepository } from "../repositories/SumUpOperatorRepository.js";
import { UserRepository } from "../repositories/UserRepository.js";
import { PaymentSettingsService } from "./PaymentSettingsService.js";
import { emitPaymentUpdated } from "../realtime/socketServer.js";

// Nada aqui depende de webhook: o status vem sempre de consulta à API da SumUp.
//
// Maquininha (igual ao CompactPay): nem o ID do reader nem o webhook são
// confiáveis, então cada maquininha fica logada com um usuário SumUp próprio e
// consultamos o histórico de vendas. Uma venda aprovada é do pedido que está
// aguardando naquela maquininha (mesmo usuário) com o mesmo valor.
// Com o reader pareado, a cobrança também vai para a tela da maquininha
// (Cloud API) e a venda é consultada pelo client_transaction_id.
//   Order.terminalIntentId: "sumup-user:<email>:<enviadoEmMs>[:<readerId>:<clientTransactionId>]"
//
// Online (delivery): checkout da SumUp (Pix com QR na tela ou cartão na
// página hospedada), consultado até ficar PAID, FAILED ou EXPIRED.
//   Order.terminalIntentId: "sumup-checkout:<checkoutId>:<criadoEmMs>"
const TERMINAL_PREFIX = "sumup-user:";
const CHECKOUT_PREFIX = "sumup-checkout:";

const POLL_INTERVAL_MS =
  Number(process.env.SUMUP_POLL_INTERVAL_SECONDS || 10) * 1000;
// Depois disso o pedido deixa de ser casado automaticamente.
const AWAITING_WINDOW_MS = 30 * 60 * 1000;
// A página hospedada da SumUp vale 30 min; folga para o Pix pago no limite.
const CHECKOUT_WINDOW_MS = 60 * 60 * 1000;
// Folga no changes_since para vendas que demoram a aparecer no histórico.
const CHANGES_SINCE_MARGIN_MS = 5 * 60 * 1000;
// Venda feita um pouco antes de o pedido chegar na tela (relógios diferentes).
const CLOCK_SKEW_MS = 2 * 60 * 1000;

let pollTimer = null;
let polling = false;

const toCents = (value) => Math.round(Number(value) * 100);
const toSumUpDate = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const splitIntent = (intentId, prefix) => {
  if (!String(intentId ?? "").startsWith(prefix)) return null;
  const rest = intentId.slice(prefix.length);
  const separator = rest.lastIndexOf(":");
  return { value: rest.slice(0, separator), sentAt: Number(rest.slice(separator + 1)) || 0 };
};

export const isSumUpIntent = (intentId) =>
  String(intentId ?? "").startsWith("sumup-");

export const parseSumUpIntent = (intentId) => {
  if (!String(intentId ?? "").startsWith(TERMINAL_PREFIX)) return null;
  const [email, sentAt, readerId, clientTransactionId] = intentId
    .slice(TERMINAL_PREFIX.length)
    .split(":");
  return {
    email: email.toLowerCase(),
    sentAt: Number(sentAt) || 0,
    readerId: readerId || null,
    clientTransactionId: clientTransactionId || null,
  };
};

const TRANSACTION_STATUS_MAP = {
  SUCCESSFUL: "APROVADO",
  FAILED: "RECUSADO",
  CANCELLED: "RECUSADO",
};

const parseCheckoutIntent = (intentId) => {
  const intent = splitIntent(intentId, CHECKOUT_PREFIX);
  return intent && { checkoutId: intent.value, sentAt: intent.sentAt };
};

export class SumUpPaymentService {
  constructor(
    orderRepository = new OrderRepository(),
    paymentRepository = new PaymentRepository(),
    sumUpOperatorRepository = new SumUpOperatorRepository(),
    paymentSettingsService = new PaymentSettingsService(),
    userRepository = new UserRepository(),
  ) {
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
    this.sumUpOperatorRepository = sumUpOperatorRepository;
    this.paymentSettingsService = paymentSettingsService;
    this.userRepository = userRepository;
  }

  // Marca o pedido como "aguardando na maquininha <usuário>". Se ela tem
  // reader pareado, a cobrança vai para a tela dela; senão o valor é digitado
  // na maquininha. Nos dois casos o poller confirma quando a venda aparecer.
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

    // Cobrança anterior ainda aberta na tela da maquininha: encerra antes.
    await this.cancelTerminalCharge(order);

    let sent = null;
    if (operator.readerId) {
      try {
        const { client, merchantCode } =
          await this.paymentSettingsService.requireSumUpClient();
        sent = await client.createReaderCheckout(merchantCode, operator.readerId, {
          amount: order.total,
          description: `Pedido Dubob #${order.id.slice(-6).toUpperCase()}`,
        });
      } catch (error) {
        // Maquininha desligada/sem internet: segue com o valor digitado nela.
        console.warn(
          `[SumUp] Não foi possível enviar para a maquininha ${operator.name}:`,
          error.message,
        );
      }
    }

    const intent = [TERMINAL_PREFIX + email, Date.now()];
    if (sent) intent.push(operator.readerId, sent.clientTransactionId ?? "");
    await this.orderRepository.saveTerminalIntentId(order.id, intent.join(":"));
    console.log(
      `[SumUp] Pedido ${order.id} aguardando na maquininha ${email}` +
        (sent ? ` (cobrança enviada ao reader ${operator.readerId})` : ""),
    );
    this.ensurePolling();

    return {
      provider: "SUMUP",
      mode: sent ? "sent" : "manual",
      deviceId: email,
      terminalName: operator.name,
      amount: Number(order.total).toFixed(2),
      status: "waiting",
    };
  }

  // Encerra a cobrança aberta na tela do reader. Devolve false se não deu
  // para garantir que ela foi fechada (aí o pedido não deve ser cancelado).
  async cancelTerminalCharge(order) {
    const intent = parseSumUpIntent(order.terminalIntentId);
    if (!intent?.readerId) return true;
    try {
      const { client, merchantCode } =
        await this.paymentSettingsService.requireSumUpClient();
      await client.terminateReaderCheckout(merchantCode, intent.readerId);
      return true;
    } catch (error) {
      // 4xx = nada aberto na maquininha (já pago, expirado ou cancelado nela).
      const nothingOpen = error.providerStatus >= 400 && error.providerStatus < 500;
      if (!nothingOpen) console.warn("[SumUp] terminate falhou:", error.message);
      return nothingOpen;
    }
  }

  // Pix online: QR code e copia-e-cola mostrados no próprio checkout.
  async startOnlinePix(order) {
    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    const checkout = await this.#createCheckout(client, merchantCode, order);

    const user = order.userId ? await this.userRepository.findById(order.userId) : null;
    const [firstName, ...lastNames] = String(user?.name ?? "").trim().split(/\s+/);
    const taxId = String(user?.cpf ?? "").replace(/\D/g, "");
    const personalDetails = user
      ? {
          ...(user.email ? { email: user.email } : {}),
          ...(firstName ? { first_name: firstName } : {}),
          ...(lastNames.length ? { last_name: lastNames.join(" ") } : {}),
          ...(taxId ? { tax_id: taxId } : {}),
        }
      : null;

    const processed = await client.processPixCheckout(checkout.id, personalDetails);
    const artefacts = processed?.artefacts ?? processed?.next_step?.artefacts ?? [];
    const findArtefact = (name) =>
      artefacts.find((item) => String(item?.name ?? "").toLowerCase() === name);
    const barcode = findArtefact("barcode");

    const qrCode = await client.readArtefact(findArtefact("code"));
    const qrCodeImageUrl = barcode?.location ?? null;
    if (!qrCode && !qrCodeImageUrl) {
      console.error("[SumUp] Pix sem artefatos:", JSON.stringify(processed));
      throw new AppError(
        "A SumUp não gerou o Pix. Confira se o Pix online está ativo na conta SumUp.",
        502,
      );
    }

    return {
      provider: "SUMUP",
      checkoutId: checkout.id,
      qrCode,
      qrCodeImageUrl,
      amount: Number(order.total).toFixed(2),
    };
  }

  // Cartão online: página de pagamento hospedada pela SumUp.
  async startOnlineCard(order) {
    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    const frontendUrl = process.env.FRONTEND_URL || "https://dubob.selfmachine.com.br";
    const checkout = await this.#createCheckout(client, merchantCode, order, {
      hostedCheckout: true,
      redirectUrl: `${frontendUrl}/dashboard`,
    });
    if (!checkout.hosted_checkout_url) {
      throw new AppError("A SumUp não devolveu a página de pagamento.", 502);
    }
    return {
      provider: "SUMUP",
      checkoutId: checkout.id,
      url: checkout.hosted_checkout_url,
    };
  }

  async #createCheckout(client, merchantCode, order, options = {}) {
    // checkout_reference precisa ser único: um pedido pode gerar mais de um checkout.
    const createdAt = Date.now();
    const checkout = await client.createCheckout(merchantCode, {
      amount: order.total,
      reference: `${order.id}-${createdAt}`,
      description: `Pedido Dubob #${order.id.slice(-6).toUpperCase()}`,
      ...options,
    });
    if (!checkout?.id) throw new AppError("A SumUp não criou o checkout.", 502);

    await this.orderRepository.saveTerminalIntentId(
      order.id,
      `${CHECKOUT_PREFIX}${checkout.id}:${createdAt}`,
    );
    console.log(`[SumUp] Checkout ${checkout.id} criado -> pedido ${order.id}`);
    this.ensurePolling();
    return checkout;
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
    const rows = await this.orderRepository.findAwaitingSumUpOrders();
    const terminal = rows
      .map((order) => ({ ...order, intent: parseSumUpIntent(order.terminalIntentId) }))
      .filter((order) => order.intent && now - order.intent.sentAt < AWAITING_WINDOW_MS);
    const online = rows
      .map((order) => ({ ...order, intent: parseCheckoutIntent(order.terminalIntentId) }))
      .filter((order) => order.intent && now - order.intent.sentAt < CHECKOUT_WINDOW_MS);
    if (!terminal.length && !online.length) return null;

    const { client, merchantCode } =
      await this.paymentSettingsService.requireSumUpClient();
    let matched = 0;
    if (terminal.length) {
      matched += await this.#syncTerminalOrders(client, merchantCode, terminal);
    }
    for (const order of online) {
      if (await this.#syncCheckoutOrder(client, order)) matched += 1;
    }
    return matched;
  }

  async #syncTerminalOrders(client, merchantCode, awaiting) {
    let matched = 0;

    // Cobranças enviadas ao reader: consulta direta pelo client_transaction_id.
    for (const order of [...awaiting]) {
      const { clientTransactionId } = order.intent;
      if (!clientTransactionId) continue;
      const transaction = await client.getTransactionByClientId(
        merchantCode,
        clientTransactionId,
      );
      const status = TRANSACTION_STATUS_MAP[String(transaction?.status ?? "").toUpperCase()];
      if (!status) continue;

      awaiting.splice(awaiting.indexOf(order), 1);
      if (status === "RECUSADO") {
        await this.#refuse(order, `venda ${transaction.status} na maquininha`);
        continue;
      }
      const externalId = `sumup:${transaction.id ?? clientTransactionId}`;
      if (await this.paymentRepository.existsByExternalId(externalId)) continue;
      await this.#approve(order, externalId, transaction, order.intent.email);
      matched += 1;
    }
    if (!awaiting.length) return matched;

    const oldestSentAt = Math.min(...awaiting.map((order) => order.intent.sentAt));
    const transactions = await client.listSuccessfulTransactions(
      merchantCode,
      toSumUpDate(oldestSentAt - CHANGES_SINCE_MARGIN_MS),
    );

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

      await this.#approve(order, externalId, transaction, order.intent.email);
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

  async #syncCheckoutOrder(client, order) {
    const checkout = await client.getCheckout(order.intent.checkoutId);
    const status = String(checkout?.status ?? "").toUpperCase();

    if (status === "PAID") {
      if (toCents(checkout.amount) !== toCents(order.total)) {
        console.error(
          `[SumUp] Checkout ${checkout.id} pago com valor diferente do pedido ${order.id}.`,
        );
        return false;
      }
      const transaction =
        (checkout.transactions ?? []).find(
          (item) => String(item.status ?? "").toUpperCase() === "SUCCESSFUL",
        ) ?? {};
      const externalId = `sumup:${transaction.id ?? checkout.id}`;
      if (await this.paymentRepository.existsByExternalId(externalId)) return false;
      await this.#approve(order, externalId, checkout, `checkout ${checkout.id}`);
      return true;
    }

    if (status === "FAILED" || status === "EXPIRED") {
      await this.#refuse(order, `checkout ${checkout.id} ${status}`);
    }
    return false;
  }

  async #refuse(order, reason) {
    await this.orderRepository.updatePaymentStatus(order.id, "RECUSADO");
    emitPaymentUpdated({
      orderId: order.id,
      userId: order.userId,
      paymentStatus: "RECUSADO",
    });
    console.log(`[SumUp] Pedido ${order.id} RECUSADO (${reason})`);
  }

  async #approve(order, externalId, payload, origin) {
    await this.paymentRepository.upsertFromWebhook({
      orderId: order.id,
      provider: "SUMUP",
      externalId,
      status: "APROVADO",
      payload,
      amount: order.total,
    });
    await this.orderRepository.updatePaymentStatus(order.id, "APROVADO");
    emitPaymentUpdated({
      orderId: order.id,
      userId: order.userId,
      paymentStatus: "APROVADO",
    });
    console.log(`[SumUp poller] ✅ Pedido ${order.id} aprovado (${externalId}, ${origin})`);
  }
}
