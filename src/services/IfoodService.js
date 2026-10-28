import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError.js";
import { prisma } from "../lib/prisma.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { decryptSecret, encryptSecret } from "../lib/secretBox.js";
import {
  emitOrderCreated,
  emitOrderStatusUpdated,
  emitOrderUpdated,
} from "../realtime/socketServer.js";
import { IfoodClient } from "./IfoodClient.js";

// Pedidos do iFood entram no duBob como pedidos normais (cozinha, caixa,
// histórico). A cada 30s consultamos os eventos do iFood — o polling também é
// o que mantém a loja "aberta" lá — e as mudanças de status feitas aqui
// voltam para o iFood (confirmar, preparo, pronto, saiu, cancelar).

export const IFOOD_SOURCE = "IFOOD";
// Usuário e produto de sistema criados na migração (server.js)
export const IFOOD_USER_ID = "db_user_ifood";
export const IFOOD_FALLBACK_PRODUCT_ID = "db_ifood_item";

const POLL_INTERVAL_MS = 30 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
// Motivo usado quando o pedido é cancelado fora da cozinha (ex.: caixa), se o
// iFood aceitar: "Dificuldades internas do restaurante"
const CANCEL_CODE = "509";
const TIMEZONE = "America/Sao_Paulo";
const CANCEL_REASON = "Pedido cancelado pela loja";

const KEYS = {
  ativo: "ifood_ativo",
  clientId: "ifood_client_id",
  clientSecret: "ifood_client_secret",
  merchantId: "ifood_merchant_id",
  autoConfirmar: "ifood_auto_confirmar",
};

const PAYMENT_LABELS = {
  CASH: "Dinheiro",
  CREDIT: "Crédito",
  DEBIT: "Débito",
  MEAL_VOUCHER: "Vale-refeição",
  FOOD_VOUCHER: "Vale-alimentação",
  PIX: "PIX",
  DIGITAL_WALLET: "Carteira digital",
};

const normalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const money = (value) => Number(value ?? 0).toFixed(2);
const brl = (value) => `R$ ${money(value).replace(".", ",")}`;
// O texto do pedido usa "|" como separador
const clean = (value) => String(value ?? "").replace(/\|/g, "/").trim();

const formatDateTime = (iso) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });

// Pedido agendado: o cliente escolheu o horário de entrega/retirada
export const getScheduledStart = (ifoodOrder) =>
  String(ifoodOrder?.orderTiming ?? "").toUpperCase() === "SCHEDULED"
    ? (ifoodOrder?.schedule?.deliveryDateTimeStart ?? null)
    : null;

const SPONSOR_LABELS = { IFOOD: "iFood", MERCHANT: "loja" };

// Cupons e descontos, com quem paga cada parte
export function buildBenefitsNote(ifoodOrder) {
  const benefits = Array.isArray(ifoodOrder?.benefits) ? ifoodOrder.benefits : [];
  const total = benefits.reduce((sum, b) => sum + Number(b.value ?? 0), 0);
  if (total <= 0) return null;
  const bySponsor = new Map();
  for (const benefit of benefits) {
    for (const part of benefit.sponsorshipValues ?? []) {
      const value = Number(part.value ?? 0);
      if (value <= 0) continue;
      const name = SPONSOR_LABELS[String(part.name).toUpperCase()] ?? clean(part.name);
      bySponsor.set(name, (bySponsor.get(name) ?? 0) + value);
    }
  }
  const split = [...bySponsor].map(([name, value]) => `${name} ${brl(value)}`).join(", ");
  return `Desconto: ${brl(total)}${split ? ` (${split})` : ""}`;
}

// Entrega feita pelo próprio motoboy da loja (o resto o iFood leva ou é retirada)
export const isMerchantDelivery = (ifoodOrder) =>
  ifoodOrder?.orderType === "DELIVERY" &&
  String(ifoodOrder?.delivery?.deliveredBy ?? "").toUpperCase() === "MERCHANT";

export function mapIfoodPayment(ifoodOrder) {
  const payments = ifoodOrder?.payments ?? {};
  const pending = Number(payments.pending ?? 0);
  const methods = Array.isArray(payments.methods) ? payments.methods : [];
  const offline = methods.find((m) => String(m.type).toUpperCase() === "OFFLINE");

  if (pending > 0 || offline) {
    const method = String(offline?.method ?? "CASH").toUpperCase();
    const changeFor = Number(offline?.cash?.changeFor ?? 0);
    const brand = offline?.card?.brand ? ` ${clean(offline.card.brand)}` : "";
    const label = `${PAYMENT_LABELS[method] ?? method}${brand}`;
    const amount = pending > 0 ? ` ${brl(pending)}` : "";
    return {
      paymentStatus: "PENDENTE",
      paymentMethod: `IFOOD_${method}`,
      note: `Cobrar na entrega${amount}: ${label}${changeFor > 0 ? ` (troco p/ ${brl(changeFor)})` : ""}`,
    };
  }
  return { paymentStatus: "APROVADO", paymentMethod: "IFOOD_ONLINE", note: "Pago no iFood" };
}

export function buildItemNotes(item) {
  const options = (Array.isArray(item.options) ? item.options : []).map((option) => {
    const qty = Number(option.quantity ?? 1);
    return `${qty > 1 ? `${qty}x ` : ""}${clean(option.name)}`.replace(/,/g, " ");
  });
  return [
    `iFood: ${clean(item.name)}`,
    options.length ? `Complementos: ${options.join(", ")}` : null,
    item.observations ? `Obs: ${clean(item.observations)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function buildOrderNotes(ifoodOrder, paymentNote) {
  const customer = ifoodOrder.customer ?? {};
  const phone = customer.phone ?? {};
  const delivery = ifoodOrder.delivery ?? {};
  const kind =
    ifoodOrder.orderType !== "DELIVERY"
      ? "Retirada no balcão"
      : isMerchantDelivery(ifoodOrder)
        ? "Entrega própria"
        : "Entrega iFood";
  const scheduledStart = getScheduledStart(ifoodOrder);
  const scheduledEnd = ifoodOrder.schedule?.deliveryDateTimeEnd;
  const takeoutAt = ifoodOrder.orderType === "TAKEOUT" && ifoodOrder.takeout?.takeoutDateTime;
  const fees = (Array.isArray(ifoodOrder.additionalFees) ? ifoodOrder.additionalFees : [])
    .filter((fee) => Number(fee.value ?? 0) > 0)
    .map((fee) => `${clean(fee.description || fee.type || "Taxa")} ${brl(fee.value)}`);
  return [
    `Pedido iFood #${ifoodOrder.displayId ?? ifoodOrder.id}`,
    `Cliente: ${clean(customer.name) || "Cliente iFood"}`,
    kind,
    scheduledStart
      ? `AGENDADO p/ ${formatDateTime(scheduledStart)}${scheduledEnd ? ` às ${formatTime(scheduledEnd)}` : ""}`
      : null,
    !scheduledStart && takeoutAt ? `Retirar às ${formatTime(takeoutAt)}` : null,
    paymentNote,
    buildBenefitsNote(ifoodOrder),
    fees.length ? `Taxas: ${fees.join(", ")}` : null,
    customer.documentNumber ? `CPF na nota: ${clean(customer.documentNumber)}` : null,
    phone.number
      ? `Tel: ${clean(phone.number)}${phone.localizer ? ` (cód. ${clean(phone.localizer)})` : ""}`
      : null,
    delivery.pickupCode ? `Código de coleta: ${clean(delivery.pickupCode)}` : null,
    delivery.deliveryAddress?.reference
      ? `Ref: ${clean(delivery.deliveryAddress.reference)}`
      : null,
    delivery.observations ? `Obs entrega: ${clean(delivery.observations)}` : null,
    ifoodOrder.extraInfo ? `Obs: ${clean(ifoodOrder.extraInfo)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function formatAddress(address) {
  if (!address) return null;
  if (address.formattedAddress) {
    return [address.formattedAddress, address.complement, address.neighborhood]
      .filter(Boolean)
      .join(" - ");
  }
  return [
    [address.streetName, address.streetNumber].filter(Boolean).join(", "),
    address.complement,
    address.neighborhood,
    address.city,
  ]
    .filter(Boolean)
    .join(" - ");
}

// Erro da API do iFood vira mensagem legível para quem clicou
async function viaIfood(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`O iFood recusou a ação: ${error.message}`, 502);
  }
}

export class IfoodService {
  constructor(
    settings = new AppSettingRepository(),
    orderRepository = new OrderRepository(),
  ) {
    this.settings = settings;
    this.orderRepository = orderRepository;
    this.client = null;
    this.clientKey = null;
    this.timer = null;
    this.polling = false;
    this.lastPollAt = null;
    this.lastError = null;
    this.lastOrderAt = null;
    // Últimos eventos recebidos, para a tela do admin (só em memória)
    this.recentEvents = [];
  }

  #registrarEvento(event, resultado) {
    this.recentEvents.unshift({
      em: new Date().toISOString(),
      codigo: event.fullCode || event.code || "?",
      pedido: String(event.orderId ?? "").slice(0, 8),
      resultado,
    });
    this.recentEvents.length = Math.min(this.recentEvents.length, 20);
  }

  async #get(key) {
    return (await this.settings.get(key))?.value ?? null;
  }

  async lerConfig() {
    const [ativo, clientId, secretEnc, merchantId, autoConfirmar] = await Promise.all([
      this.#get(KEYS.ativo),
      this.#get(KEYS.clientId),
      this.#get(KEYS.clientSecret),
      this.#get(KEYS.merchantId),
      this.#get(KEYS.autoConfirmar),
    ]);
    let clientSecret = null;
    if (secretEnc) {
      try {
        clientSecret = decryptSecret(secretEnc);
      } catch {
        clientSecret = null;
      }
    }
    return {
      ativo: ativo === "true",
      clientId: clientId || process.env.IFOOD_CLIENT_ID || null,
      clientSecret: clientSecret || process.env.IFOOD_CLIENT_SECRET || null,
      merchantId: merchantId || process.env.IFOOD_MERCHANT_ID || null,
      // Sem confirmar, o iFood cancela o pedido sozinho em poucos minutos
      autoConfirmar: autoConfirmar !== "false",
    };
  }

  #clientFor(config) {
    if (!config.clientId || !config.clientSecret) return null;
    const key = `${config.clientId}:${config.clientSecret}`;
    if (this.clientKey !== key) {
      this.client = new IfoodClient(config.clientId, config.clientSecret);
      this.clientKey = key;
    }
    return this.client;
  }

  // Para a tela do admin: o secret nunca volta inteiro
  async getStatus() {
    const config = await this.lerConfig();
    return {
      config: {
        ativo: config.ativo,
        clientId: config.clientId,
        merchantId: config.merchantId,
        autoConfirmar: config.autoConfirmar,
        clientSecretConfigurado: Boolean(config.clientSecret),
        clientSecretMascarado: config.clientSecret
          ? `${config.clientSecret.slice(0, 4)}••••${config.clientSecret.slice(-4)}`
          : null,
      },
      polling: {
        ultimaConsulta: this.lastPollAt,
        ultimoPedido: this.lastOrderAt,
        ultimoErro: this.lastError,
        eventos: this.recentEvents,
      },
    };
  }

  async updateConfig(payload = {}) {
    if (payload.clientId !== undefined) {
      await this.settings.set(KEYS.clientId, String(payload.clientId || "").trim());
    }
    if (payload.clientSecret !== undefined && String(payload.clientSecret).trim()) {
      await this.settings.set(
        KEYS.clientSecret,
        encryptSecret(String(payload.clientSecret).trim()),
      );
    }
    if (payload.merchantId !== undefined) {
      const merchantId = String(payload.merchantId || "").trim();
      if (merchantId && !/^[\w-]{8,64}$/.test(merchantId)) {
        throw new AppError("Merchant ID inválido (copie o ID da loja no Portal do Parceiro).", 422);
      }
      await this.settings.set(KEYS.merchantId, merchantId);
    }
    if (payload.autoConfirmar !== undefined) {
      await this.settings.set(KEYS.autoConfirmar, String(payload.autoConfirmar === true));
    }
    if (payload.ativo !== undefined) {
      const ativo = payload.ativo === true;
      if (ativo) {
        const config = await this.lerConfig();
        if (!config.clientId || !config.clientSecret || !config.merchantId) {
          throw new AppError("Preencha Client ID, Client Secret e Merchant ID antes de ligar.", 422);
        }
      }
      await this.settings.set(KEYS.ativo, String(ativo));
    }
    this.lastError = null;
    this.agendar(1000);
    return this.getStatus();
  }

  // Valida as credenciais e lista as lojas que o app enxerga
  async testarConexao() {
    const config = await this.lerConfig();
    const client = this.#clientFor(config);
    if (!client) throw new AppError("Preencha Client ID e Client Secret.", 422);
    const merchants = await client.testConnection();
    if (!merchants) {
      return {
        ok: true,
        lojas: null,
        aviso: "Login no iFood funcionando. A lista de lojas só aparece com o módulo Merchant homologado.",
      };
    }
    return {
      ok: true,
      lojas: merchants.map((m) => ({ id: m.id, nome: m.name ?? m.corporateName ?? m.id })),
    };
  }

  agendar(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.consultar().catch((error) => console.error("[ifood] polling:", error.message));
    }, ms);
    this.timer.unref?.();
  }

  iniciar() {
    this.agendar(10 * 1000);
  }

  async consultar() {
    if (this.polling) return;
    this.polling = true;
    this.timer = null;
    let proximaEm = POLL_INTERVAL_MS;
    try {
      const config = await this.lerConfig();
      const client = this.#clientFor(config);
      if (!config.ativo || !client) return;

      const events = await client.pollEvents(config.merchantId);
      this.lastPollAt = new Date().toISOString();
      this.lastError = null;

      if (events.length) console.log(`[ifood] ${events.length} evento(s) recebido(s)`);
      const handled = [];
      for (const event of events) {
        try {
          await this.#handleEvent(client, config, event);
          handled.push(event.id);
          this.#registrarEvento(event, "ok");
        } catch (error) {
          // Sem ack o evento volta na próxima consulta
          console.error(`[ifood] evento ${event.code} do pedido ${event.orderId}:`, error.message);
          this.lastError = error.message;
          this.#registrarEvento(event, `erro: ${error.message}`);
        }
      }
      await client.acknowledge(handled);
    } catch (error) {
      this.lastError = error.message;
      proximaEm = ERROR_RETRY_MS;
      throw error;
    } finally {
      this.polling = false;
      const config = await this.lerConfig().catch(() => null);
      if (config?.ativo) this.agendar(proximaEm);
    }
  }

  async #handleEvent(client, config, event) {
    const code = String(event.code ?? "").toUpperCase();
    const fullCode = String(event.fullCode ?? "").toUpperCase();
    if (!event.orderId) return;

    if (code === "PLC" || fullCode === "PLACED") {
      await this.importarPedido(client, event.orderId);
      if (config.autoConfirmar) await this.#confirmar(client, event.orderId);
      return;
    }

    const local = await this.#findLocalOrder(event.orderId);
    if (!local) return;

    if (code === "CFM" || fullCode === "CONFIRMED") {
      if (!local.externalPayload?.confirmado) await this.#updateMeta(local, { confirmado: true });
      return;
    }

    if (code === "CAN" || fullCode === "CANCELLED") {
      await this.#setStatus(local, "CANCELADO");
      await this.#updateMeta(local, { disputa: null });
    } else if (code === "HSD" || fullCode === "HANDSHAKE_DISPUTE") {
      // Cliente pediu cancelamento (ou reembolso): a loja aceita ou recusa
      // antes de expirar; sem resposta o iFood aplica o timeoutAction.
      const m = event.metadata ?? {};
      await this.#updateMeta(local, {
        disputa: {
          id: m.disputeId ?? m.id ?? null,
          acao: m.action ?? null,
          mensagem: m.message ?? null,
          expiraEm: m.expiresAt ?? null,
          aoExpirar: m.timeoutAction ?? null,
        },
      });
    } else if (code === "HSS" || fullCode === "HANDSHAKE_SETTLEMENT") {
      await this.#updateMeta(local, { disputa: null });
    } else if (code === "CARF" || fullCode === "CANCELLATION_REQUEST_FAILED") {
      // O iFood não aceitou o cancelamento: o pedido continua valendo lá
      const anterior = local.externalPayload?.cancelamento?.statusAnterior;
      if (local.status === "CANCELADO" && anterior) await this.#setStatus(local, anterior);
      await this.#updateMeta(local, {
        cancelamento: null,
        cancelamentoFalhou: "O iFood recusou o cancelamento. O pedido continua ativo.",
      });
      this.lastError = `iFood recusou o cancelamento do pedido #${local.externalDisplayId ?? ""}`;
    } else if (code === "DSP" || fullCode === "DISPATCHED") {
      if (["RECEBIDO", "PREPARANDO", "PRONTO"].includes(local.status)) {
        await this.#setStatus(local, "SAIU_PARA_ENTREGA");
      }
    } else if (code === "CON" || fullCode === "CONCLUDED") {
      if (!["ENTREGUE", "CANCELADO"].includes(local.status)) {
        await this.#setStatus(local, "ENTREGUE");
      }
    }
  }

  async #findLocalOrder(externalId) {
    const rows = await prisma.$queryRaw`
      SELECT id, "userId", status::text AS status, "externalId", "externalDisplayId",
             "externalPayload"
      FROM "Order"
      WHERE "externalSource" = ${IFOOD_SOURCE} AND "externalId" = ${externalId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // Confirma uma vez só. Falha temporária (rede, 5xx, 429) lança erro para o
  // evento PLC ficar sem ack e a confirmação ser tentada de novo na próxima
  // consulta; recusa definitiva (4xx, ex.: pedido já cancelado) só registra.
  async #confirmar(client, externalId) {
    const local = await this.#findLocalOrder(externalId);
    if (!local || local.externalPayload?.confirmado) return;
    try {
      await client.confirm(externalId);
    } catch (error) {
      const definitivo = error.status >= 400 && error.status < 500 && error.status !== 429;
      if (!definitivo) throw error;
      console.error("[ifood] confirmar:", error.message);
      this.lastError = error.message;
      return;
    }
    await this.#updateMeta(local, { confirmado: true });
  }

  async #findLocalById(orderId) {
    const rows = await prisma.$queryRaw`
      SELECT id, "userId", status::text AS status, "externalId", "externalDisplayId",
             "externalPayload"
      FROM "Order"
      WHERE id = ${orderId} AND "externalSource" = ${IFOOD_SOURCE}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // Junta campos no externalPayload e avisa a equipe para recarregar
  async #updateMeta(local, patch) {
    await prisma.$executeRaw`
      UPDATE "Order"
      SET "externalPayload" = COALESCE("externalPayload", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${local.id}
    `;
    local.externalPayload = { ...(local.externalPayload ?? {}), ...patch };
    emitOrderUpdated({ orderId: local.id });
  }

  // Pedido do iFood + cliente da API, para as ações da cozinha
  async #context(orderId) {
    const local = await this.#findLocalById(orderId);
    if (!local?.externalId) throw new AppError("Pedido do iFood não encontrado.", 404);
    const client = this.#clientFor(await this.lerConfig());
    if (!client) throw new AppError("Integração com o iFood não configurada.", 409);
    return { local, client };
  }

  async motivosCancelamento(orderId) {
    const { local, client } = await this.#context(orderId);
    const reasons = await viaIfood(client.cancellationReasons(local.externalId));
    return reasons.map((r) => ({ codigo: String(r.cancelCodeId), descricao: r.description }));
  }

  // O pedido só vira CANCELADO aqui quando o iFood confirmar (evento CAN)
  async cancelar(orderId, { codigo, motivo } = {}) {
    const { local, client } = await this.#context(orderId);
    if (["ENTREGUE", "CANCELADO"].includes(local.status)) {
      throw new AppError("Esse pedido não pode mais ser cancelado.", 409);
    }
    if (!codigo) throw new AppError("Escolha o motivo do cancelamento.", 422);
    await viaIfood(
      client.requestCancellation(local.externalId, {
        reason: String(motivo || CANCEL_REASON).slice(0, 250),
        cancellationCode: String(codigo),
      }),
    );
    await this.#updateMeta(local, {
      cancelamento: { codigo: String(codigo), solicitadoEm: new Date().toISOString() },
      cancelamentoFalhou: null,
    });
    this.agendar(3000);
    return { ok: true };
  }

  async responderDisputa(orderId, { aceitar, motivo } = {}) {
    const { local, client } = await this.#context(orderId);
    const disputa = local.externalPayload?.disputa;
    if (!disputa?.id) throw new AppError("Não há pedido de cancelamento do cliente.", 409);
    if (aceitar) {
      await viaIfood(client.acceptDispute(disputa.id));
    } else {
      if (!String(motivo ?? "").trim()) throw new AppError("Informe o motivo da recusa.", 422);
      await viaIfood(client.rejectDispute(disputa.id, String(motivo).trim().slice(0, 250)));
    }
    await this.#updateMeta(local, { disputa: null });
    this.agendar(3000);
    return { ok: true };
  }

  // Mudança vinda do iFood: atualiza aqui sem mandar de volta para lá
  async #setStatus(local, status) {
    if (local.status === status) return;
    await this.orderRepository.updateStatus(
      local.id,
      status,
      status === "ENTREGUE" ? new Date() : null,
    );
    emitOrderStatusUpdated({
      orderId: local.id,
      userId: local.userId,
      previousStatus: local.status,
      status,
      origin: IFOOD_SOURCE,
    });
  }

  // Produto do cardápio: pelo "código PDV" do item no iFood (= id do produto
  // aqui) ou pelo nome; sem par, entra como "Item iFood" com o nome nas notas.
  async #productMatcher() {
    const products = await prisma.product.findMany({ select: { id: true, name: true } });
    const byId = new Map(products.map((p) => [p.id, p.id]));
    const byName = new Map(products.map((p) => [normalize(p.name), p.id]));
    return (item) =>
      byId.get(String(item.externalCode ?? "").trim()) ??
      byName.get(normalize(item.name)) ??
      IFOOD_FALLBACK_PRODUCT_ID;
  }

  async importarPedido(client, ifoodOrderId) {
    const existing = await this.#findLocalOrder(ifoodOrderId);
    if (existing) return null;

    const ifoodOrder = await client.getOrder(ifoodOrderId);
    const matchProduct = await this.#productMatcher();
    const payment = mapIfoodPayment(ifoodOrder);
    const total = Number(ifoodOrder.total?.orderAmount ?? 0);
    const deliveryFee = Number(ifoodOrder.total?.deliveryFee ?? 0);
    const address = ifoodOrder.delivery?.deliveryAddress;
    const coords = address?.coordinates ?? {};
    const isPickup = !isMerchantDelivery(ifoodOrder);

    const items = (ifoodOrder.items ?? []).map((item) => {
      const quantity = Math.max(1, Math.round(Number(item.quantity ?? 1)));
      const totalPrice = Number(item.totalPrice ?? Number(item.unitPrice ?? 0) * quantity);
      return {
        productId: matchProduct(item),
        quantity,
        unitPrice: new Prisma.Decimal(money(totalPrice / quantity)),
        totalPrice: new Prisma.Decimal(money(totalPrice)),
        notes: buildItemNotes(item),
      };
    });
    if (!items.length) throw new Error("Pedido do iFood sem itens.");

    const meta = {
      orderType: ifoodOrder.orderType ?? null,
      deliveredBy: ifoodOrder.delivery?.deliveredBy ?? null,
      merchantId: ifoodOrder.merchant?.id ?? null,
      agendadoPara: getScheduledStart(ifoodOrder),
    };

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId: IFOOD_USER_ID,
          status: "RECEBIDO",
          total: new Prisma.Decimal(money(total)),
          paymentStatus: payment.paymentStatus,
          paymentMethod: payment.paymentMethod,
          deliveryAddress:
            ifoodOrder.orderType === "DELIVERY"
              ? formatAddress(address)
              : "iFood - retirada no local",
          deliveryFee: new Prisma.Decimal(money(deliveryFee)),
          ...(coords.latitude != null ? { deliveryLat: Number(coords.latitude) } : {}),
          ...(coords.longitude != null ? { deliveryLon: Number(coords.longitude) } : {}),
          isPickup,
          ...(isPickup ? {} : { deliveryCode: String(Math.floor(1000 + Math.random() * 9000)) }),
          notes: buildOrderNotes(ifoodOrder, payment.note),
          items: { create: items },
          payment: {
            create: {
              provider: IFOOD_SOURCE,
              externalId: `ifood:${ifoodOrderId}`,
              amount: new Prisma.Decimal(money(total)),
              status: payment.paymentStatus,
              payload: { paymentMethod: payment.paymentMethod, ifood: ifoodOrder.payments ?? null },
            },
          },
        },
      });
      // O índice único em externalId barra pedido duplicado
      await tx.$executeRaw`
        UPDATE "Order"
        SET "externalSource" = ${IFOOD_SOURCE},
            "externalId" = ${ifoodOrderId},
            "externalDisplayId" = ${String(ifoodOrder.displayId ?? "")},
            "externalPayload" = ${JSON.stringify(meta)}::jsonb
        WHERE id = ${created.id}
      `;
      return created;
    });

    this.lastOrderAt = new Date().toISOString();
    emitOrderCreated({
      orderId: order.id,
      userId: order.userId,
      mesaId: null,
      comandaId: null,
      status: "RECEBIDO",
      total: Number(order.total ?? 0),
      source: IFOOD_SOURCE,
    });
    return order;
  }

  // Status mudou aqui (cozinha, caixa, motoboy): avisa o iFood.
  // Nunca lança erro: o iFood não pode travar a cozinha.
  async onOrderEvent(tipo, payload) {
    if (tipo !== "status" || payload?.origin === IFOOD_SOURCE || !payload?.orderId) return;
    try {
      const local = await this.#findLocalById(payload.orderId);
      if (!local?.externalId) return;
      const config = await this.lerConfig();
      const client = this.#clientFor(config);
      if (!client) return;

      const meta = local.externalPayload ?? {};
      const merchantDelivery =
        meta.orderType === "DELIVERY" && String(meta.deliveredBy).toUpperCase() === "MERCHANT";
      const id = local.externalId;

      if (payload.status === "PREPARANDO") {
        if (!meta.confirmado) await this.#confirmar(client, id).catch(() => {});
        await client.startPreparation(id);
      } else if (payload.status === "PRONTO") {
        await client.readyToPickup(id);
      } else if (payload.status === "SAIU_PARA_ENTREGA" && merchantDelivery) {
        // O iFood exige readyToPickup antes do dispatch; se pulou o "Pronto", manda agora
        if (payload.previousStatus !== "PRONTO") await client.readyToPickup(id).catch(() => {});
        await client.dispatch(id);
      } else if (payload.status === "CANCELADO" && !meta.cancelamento) {
        // Cancelado fora da cozinha: usa um motivo que o iFood aceite agora
        const reasons = await client.cancellationReasons(id);
        const reason =
          reasons.find((r) => String(r.cancelCodeId) === CANCEL_CODE) ?? reasons[0];
        if (!reason) throw new Error("o iFood não permite cancelar esse pedido agora");
        await client.requestCancellation(id, {
          reason: CANCEL_REASON,
          cancellationCode: String(reason.cancelCodeId),
        });
        await this.#updateMeta(local, {
          cancelamento: {
            codigo: String(reason.cancelCodeId),
            solicitadoEm: new Date().toISOString(),
            statusAnterior: payload.previousStatus ?? null,
          },
        });
        this.agendar(3000);
      }
    } catch (error) {
      this.lastError = error.message;
      console.error("[ifood] atualizar status no iFood:", error.message);
    }
  }
}

export const ifoodService = new IfoodService();
