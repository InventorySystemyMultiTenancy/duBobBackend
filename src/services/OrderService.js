import { MercadoPagoConfig, Payment as MPPayment } from "mercadopago";
import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError.js";
import { prisma } from "../lib/prisma.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { PaymentRepository } from "../repositories/PaymentRepository.js";
import {
  emitOrderCreated,
  emitOrderStatusUpdated,
  emitPaymentUpdated,
} from "../realtime/socketServer.js";

const ORDER_TRANSITIONS = {
  RECEBIDO: ["PREPARANDO"],
  PREPARANDO: ["PRONTO"],
  PRONTO: ["SAIU_PARA_ENTREGA"],
  SAIU_PARA_ENTREGA: ["ENTREGUE"],
  ENTREGUE: [],
  CANCELADO: [],
};

const PAYMENT_STATUS_MAP = {
  approved: "APROVADO",
  rejected: "RECUSADO",
  cancelled: "RECUSADO",
  refunded: "ESTORNADO",
  in_process: "PENDENTE",
  pending: "PENDENTE",
};

const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => (value / 100).toFixed(2);
const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const isMercadoPagoInternalReference = (value) =>
  !!value && /^INSTORE-/i.test(String(value));

export class OrderService {
  constructor(
    orderRepository = new OrderRepository(),
    paymentRepository = new PaymentRepository(),
  ) {
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
  }

  async createOrder({
    userId,
    mesaId,
    comandaId,
    deliveryAddress,
    notes,
    items,
    paymentMethod,
    deliveryFee,
    deliveryLat,
    deliveryLon,
    isPickup,
  }) {
    if (!userId && !mesaId && !comandaId) {
      throw new AppError(
        "Pedido deve ser vinculado a um usuario, mesa ou comanda.",
        422,
      );
    }

    if (!items?.length) {
      throw new AppError("Pedido deve conter ao menos 1 item.", 422);
    }

    const order = await prisma.$transaction(
      async (tx) => {
        const normalizedItems = [];

        for (const item of items) {
          const normalized = await this.#normalizeItemInTransaction(tx, item);
          normalizedItems.push(normalized);
        }

        const totalCents = normalizedItems.reduce(
          (acc, item) => acc + item.totalPriceCents,
          0,
        );

        const paymentPayload = {
          provider: "MERCADO_PAGO",
          amount: new Prisma.Decimal(fromCents(totalCents)),
          status: "PENDENTE",
          payload: {
            paymentMethod: paymentMethod || "nao_informado",
          },
        };

        const orderCreateData = {
          ...(userId ? { userId } : {}),
          ...(mesaId ? { mesaId } : {}),
          ...(comandaId ? { comandaId } : {}),
          deliveryAddress: deliveryAddress ?? null,
          notes,
          status: "PREPARANDO",
          total: new Prisma.Decimal(fromCents(totalCents)),
          paymentStatus: "PENDENTE",
          ...(isPickup != null ? { isPickup } : {}),
          ...(isPickup
            ? {}
            : {
                deliveryCode: String(Math.floor(1000 + Math.random() * 9000)),
              }),
          ...(paymentMethod != null ? { paymentMethod } : {}),
          ...(deliveryFee != null
            ? { deliveryFee: new Prisma.Decimal(deliveryFee) }
            : {}),
          ...(deliveryLat != null ? { deliveryLat } : {}),
          ...(deliveryLon != null ? { deliveryLon } : {}),
          items: {
            create: normalizedItems.map((item) => ({
              quantity: item.quantity,
              unitPrice: new Prisma.Decimal(fromCents(item.unitPriceCents)),
              totalPrice: new Prisma.Decimal(fromCents(item.totalPriceCents)),
              productId: item.productId,
              addons: item.addons,
              removedIngredients: item.removedIngredients,
              notes: item.notes ?? null,
            })),
          },
          payment: {
            create: paymentPayload,
          },
        };

        try {
          return await tx.order.create({
            data: orderCreateData,
            include: {
              items: true,
              payment: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  role: true,
                },
              },
            },
          });
        } catch (error) {
          if (!this.#isMissingColumnError(error)) {
            throw error;
          }

          console.warn(
            "[OrderService.createOrder] Fallback por coluna ausente no banco:",
            error.message,
          );

          const orderColumns = await this.#getTableColumns(tx, "Order");
          const compatibleOrderData = this.#buildOrderDataForColumns(
            orderCreateData,
            orderColumns,
          );

          try {
            return await tx.order.create({
              data: compatibleOrderData,
              include: {
                items: true,
                payment: true,
              },
            });
          } catch (compatError) {
            if (!this.#isMissingColumnError(compatError)) {
              throw compatError;
            }

            console.warn(
              "[OrderService.createOrder] Fallback sem nested payment por coluna ausente:",
              compatError.message,
            );

            const dataWithoutNestedPayment = { ...compatibleOrderData };
            delete dataWithoutNestedPayment.payment;

            const createdOrder = await tx.order.create({
              data: dataWithoutNestedPayment,
              include: { items: true },
            });

            try {
              await tx.payment.create({
                data: {
                  orderId: createdOrder.id,
                  ...paymentPayload,
                },
              });
            } catch (paymentError) {
              if (!this.#isMissingColumnError(paymentError)) {
                throw paymentError;
              }

              console.warn(
                "[OrderService.createOrder] Payment não criado por schema legado:",
                paymentError.message,
              );
            }

            return { ...createdOrder, payment: null };
          }
        }
      },
      { timeout: 30000 },
    );

    emitOrderCreated({
      orderId: order.id,
      userId: order.userId,
      mesaId: order.mesaId,
      comandaId: order.comandaId,
      status: order.status ?? "PREPARANDO",
      total: Number(order.total ?? 0),
    });

    return order;
  }

  async cancelOrder(orderId) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    if (order.status === "ENTREGUE") {
      throw new AppError("Pedido ja entregue nao pode ser cancelado.", 409);
    }

    if (order.status === "CANCELADO") {
      throw new AppError("Pedido ja esta cancelado.", 409);
    }

    const updatedOrder = await this.orderRepository.updateStatus(
      orderId,
      "CANCELADO",
    );

    emitOrderStatusUpdated({
      orderId: updatedOrder.id,
      userId: order.userId,
      previousStatus: order.status,
      status: "CANCELADO",
      paymentWasPending: order.paymentStatus === "PENDENTE",
    });

    return updatedOrder;
  }

  async updateOrderStatus(orderId, nextStatus) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    if (order.status === nextStatus) {
      return order;
    }

    const allowedTransitions = [...(ORDER_TRANSITIONS[order.status] ?? [])];

    if (
      order.status === "PREPARANDO" &&
      nextStatus === "SAIU_PARA_ENTREGA" &&
      (order.mesaId || order.isPickup)
    ) {
      allowedTransitions.push("SAIU_PARA_ENTREGA");
    }

    if (!allowedTransitions.includes(nextStatus)) {
      throw new AppError(
        `Transicao invalida de ${order.status} para ${nextStatus}.`,
        409,
      );
    }

    if (
      nextStatus === "SAIU_PARA_ENTREGA" &&
      !order.mesaId &&
      !order.isPickup &&
      !order.assignedMotoboyId
    ) {
      throw new AppError(
        "Selecione um motoboy antes de enviar para entrega.",
        422,
      );
    }

    const deliveredAt = nextStatus === "ENTREGUE" ? new Date() : null;
    const updatedOrder = await this.orderRepository.updateStatus(
      orderId,
      nextStatus,
      deliveredAt,
    );

    emitOrderStatusUpdated({
      orderId: updatedOrder.id,
      userId: order.userId,
      previousStatus: order.status,
      status: updatedOrder.status,
    });

    return updatedOrder;
  }

  async handlePaymentWebhook(payload) {
    // Formatos suportados:
    // 1. Nova API /v1/orders (MP Point):  { type: "order", action: "order.processed", data: { id: "ORD...", external_reference: "...", status: "processed" } }
    // 2. MP Point legado:                 { type: "point_integration_wh", data: { id: "<intent_id>", payment_id: 123 } }
    // 3. Checkout/PIX (novo):             { type: "payment", data: { id: "<payment_id>" } }
    // 4. Formato antigo (legado):         { resource: "123456", topic: "payment" }

    const isOrderWebhook = payload?.type === "order"; // nova API /v1/orders
    const isPointWebhook = payload?.type === "point_integration_wh";
    const isLegacyWebhook =
      !!payload?.topic && !!payload?.resource && !payload?.type;

    let providerStatus = "pending";
    let orderId =
      payload?.data?.external_reference ?? // nova API /v1/orders
      payload?.external_reference ??
      payload?.additional_info?.external_reference ??
      payload?.data?.metadata?.order_id ??
      payload?.metadata?.order_id;
    let externalId = "";

    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (isOrderWebhook) {
      // Nova API /v1/orders — o payload já tem tudo que precisamos
      const action = payload?.action ?? "";
      const orderData = payload?.data ?? {};
      externalId = String(orderData.id ?? "");
      orderId = orderId || orderData.external_reference;

      console.log(
        "[webhook] Nova API /v1/orders. action:",
        action,
        "| orderId:",
        orderId,
        "| status:",
        orderData.status,
      );

      // Mapeia status da order para providerStatus
      if (action === "order.processed" || orderData.status === "processed") {
        providerStatus = "approved";
      } else if (
        action === "order.canceled" ||
        orderData.status === "canceled" ||
        orderData.status === "expired"
      ) {
        providerStatus = "cancelled";
      } else if (action === "order.failed" || orderData.status === "failed") {
        providerStatus = "rejected";
      } else if (
        action === "order.refunded" ||
        orderData.status === "refunded"
      ) {
        providerStatus = "refunded";
      } else {
        // order.action_required, at_terminal, created — ainda processando
        providerStatus = "pending";
      }
    } else if (isLegacyWebhook) {
      // Formato antigo: { resource: "156011841118", topic: "payment" }
      // resource pode ser um número ou URL como /v1/payments/123456
      const rawResource = String(payload.resource ?? "");
      const rawPaymentId = rawResource.replace(/\D/g, "") || rawResource;
      externalId = rawPaymentId;

      console.log(
        "[webhook] Formato antigo. topic:",
        payload.topic,
        "paymentId:",
        rawPaymentId,
      );

      if (rawPaymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({ id: rawPaymentId });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          const rawRef =
            paymentData.external_reference ||
            paymentData.additional_info?.external_reference;
          // Ignora referências internas do MP (ex: "INSTORE-...") — não são nosso orderId
          const isInternalRef = rawRef && /^INSTORE-/i.test(String(rawRef));
          orderId = orderId || (isInternalRef ? null : rawRef);
          externalId = String(paymentData.id ?? rawPaymentId);
          console.log(
            "[webhook] Legacy payment status:",
            providerStatus,
            "orderId:",
            orderId,
            "ext_ref:",
            paymentData.external_reference,
            "additional_info:",
            JSON.stringify(paymentData.additional_info),
          );

          console.log(
            "[webhook] paymentData.order:",
            JSON.stringify(paymentData.order),
          );

          if (!orderId) {
            orderId = await this.#findOrderIdByTerminalReferences(paymentData);
          }

          // Fallback: busca a Order da nova API /v1/orders usando o order.id do pagamento
          // Isso resolve o caso em que a maquininha (Point) paga via /v1/orders mas o
          // webhook chega no formato legado com external_reference=null
          if (!orderId) {
            const mpOrderId =
              paymentData?.order?.id != null
                ? String(paymentData.order.id)
                : null;
            console.log(
              "[webhook] Tentando fallback via /v1/orders com mpOrderId:",
              mpOrderId,
            );
            if (mpOrderId && mpToken) {
              try {
                // 1. Tenta buscar diretamente na nova API /v1/orders/{id}
                const orderResp = await fetch(
                  `https://api.mercadopago.com/v1/orders/${mpOrderId}`,
                  { headers: { Authorization: `Bearer ${mpToken}` } },
                );
                if (orderResp.ok) {
                  const mpOrder = await orderResp.json();
                  const extRef = mpOrder.external_reference;
                  console.log(
                    "[webhook] /v1/orders extRef:",
                    extRef,
                    "status:",
                    mpOrder.status,
                  );
                  if (extRef && !isMercadoPagoInternalReference(extRef)) {
                    orderId = extRef;
                    console.log(
                      "[webhook] orderId recuperado via /v1/orders:",
                      orderId,
                    );
                  }
                }

                // 2. Se ainda não encontrou, tenta por terminalIntentId no banco
                if (!orderId) {
                  const orderByIntent =
                    await this.orderRepository.findByTerminalIntentId?.(
                      mpOrderId,
                    );
                  if (orderByIntent?.id) {
                    orderId = orderByIntent.id;
                    console.log(
                      "[webhook] orderId recuperado via terminalIntentId:",
                      orderId,
                    );
                  }
                }
              } catch (fe) {
                console.warn(
                  "[webhook] Falha no fallback /v1/orders:",
                  fe.message,
                );
              }
            }
          }

          // Último recurso: pagamento aprovado da maquininha sem external_reference.
          // Busca o pedido PENDENTE mais recente com terminalIntentId que bate com o valor.
          if (!orderId && providerStatus === "approved") {
            const txAmount = paymentData?.transaction_amount;
            if (txAmount != null) {
              const amountCents = toCents(txAmount);
              const orderByAmount =
                await this.orderRepository.findPendingTerminalOrderByAmount?.(
                  amountCents,
                );
              if (orderByAmount?.id) {
                orderId = orderByAmount.id;
                console.log(
                  "[webhook] orderId recuperado por valor do pagamento:",
                  orderId,
                  "| amount:",
                  txAmount,
                );
              } else {
                console.warn(
                  "[webhook] Sem pedido pendente da maquininha com valor R$",
                  txAmount,
                  "— payload ignorado.",
                );
              }
            }
          }
        } catch (e) {
          console.error("[webhook] Falha ao buscar payment legado:", e.message);
        }
      }
    } else if (isPointWebhook) {
      // Para pagamentos da maquininha:
      // 1. Buscar o intent para pegar external_reference e estado
      // 2. Se houver payment_id, buscar o pagamento para confirmar status
      const intentId = payload?.data?.id;
      const paymentId = payload?.data?.payment_id;

      console.log(
        "[webhook] Point webhook. intentId:",
        intentId,
        "paymentId:",
        paymentId,
      );

      if (intentId && mpToken) {
        try {
          const intentResp = await fetch(
            `https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`,
            { headers: { Authorization: `Bearer ${mpToken}` } },
          );
          const intentData = await intentResp.json();
          // external_reference está na raiz do intent (ou em additional_info para intents antigos)
          orderId =
            orderId ||
            intentData?.external_reference ||
            intentData?.additional_info?.external_reference;
          console.log(
            "[webhook] intent state:",
            intentData?.state,
            "| external_reference:",
            intentData?.external_reference,
            "| additional_info.ext_ref:",
            intentData?.additional_info?.external_reference,
          );
        } catch (e) {
          console.error("[webhook] Falha ao buscar intent:", e.message);
        }
      }

      if (paymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({ id: String(paymentId) });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          orderId = orderId || paymentData.external_reference;
          externalId = String(paymentData.id ?? paymentId);
          console.log(
            "[webhook] Point payment status:",
            providerStatus,
            "orderId:",
            orderId,
          );
        } catch (e) {
          console.error("[webhook] Falha ao buscar payment:", e.message);
          // Derivar status do state do intent apenas como fallback seguro
          const state = String(payload?.data?.state ?? "").toUpperCase();
          if (state === "CANCELED" || state === "CANCELLED")
            providerStatus = "cancelled";
          // Não assume approved para FINISHED — o status real virá do pagamento real
          else providerStatus = "pending";
          externalId = String(paymentId ?? intentId ?? "");
        }
      } else {
        // Sem payment_id ainda — verifica pelo external_reference se FINISHED
        const state = String(payload?.data?.state ?? "").toUpperCase();
        if (state === "CANCELED" || state === "CANCELLED") {
          providerStatus = "cancelled";
        } else if (state === "FINISHED" && orderId) {
          // Busca o pagamento real pelo external_reference para confirmar status
          try {
            const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${orderId}`;
            const searchResp = await fetch(searchUrl, {
              headers: { Authorization: `Bearer ${mpToken}` },
            });
            if (searchResp.ok) {
              const searchData = await searchResp.json();
              const latestPayment = searchData?.results?.[0];
              if (latestPayment) {
                providerStatus = (
                  latestPayment.status ?? "pending"
                ).toLowerCase();
                externalId = String(latestPayment.id ?? "");
                console.log(
                  "[webhook] FINISHED buscado via search, status real:",
                  providerStatus,
                );
              } else {
                providerStatus = "pending";
              }
            } else {
              providerStatus = "pending";
            }
          } catch (se) {
            console.error(
              "[webhook] Falha ao buscar pagamento FINISHED:",
              se.message,
            );
            providerStatus = "pending";
          }
        } else {
          providerStatus = "pending";
        }
        externalId = String(intentId ?? "");
        console.log(
          "[webhook] Point sem payment_id, state:",
          state,
          "-> providerStatus:",
          providerStatus,
        );
      }
    } else {
      // Webhook normal de pagamento (PIX / checkout)
      const rawPaymentId = payload?.data?.id ?? payload?.id;
      externalId = String(rawPaymentId ?? "");

      if (rawPaymentId && mpToken) {
        try {
          const client = new MercadoPagoConfig({ accessToken: mpToken });
          const paymentApi = new MPPayment(client);
          const paymentData = await paymentApi.get({
            id: String(rawPaymentId),
          });
          providerStatus = (paymentData.status ?? "pending").toLowerCase();
          orderId = orderId || paymentData.external_reference;
          externalId = String(paymentData.id ?? rawPaymentId);
        } catch {
          // fall through with defaults
        }
      } else {
        providerStatus = String(
          payload?.data?.status ?? payload?.status ?? "pending",
        ).toLowerCase();
      }
    }

    const paymentStatus = PAYMENT_STATUS_MAP[providerStatus] ?? "PENDENTE";

    if (!orderId) {
      // Pode ser um pagamento externo ao sistema (ex: INSTORE do MP) — ignora silenciosamente
      console.warn(
        "[webhook] Sem orderId identificável. Payload ignorado:",
        JSON.stringify(payload),
      );
      return { orderId: null, paymentStatus: null, ignored: true };
    }

    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado para o webhook recebido.", 404);
    }

    await this.paymentRepository.upsertFromWebhook({
      orderId,
      externalId: externalId || null,
      status: paymentStatus,
      payload,
      amount: order.total,
    });

    await this.orderRepository.updatePaymentStatus(orderId, paymentStatus);
    console.log(
      `[webhook] ✅ Pedido ${orderId} atualizado para paymentStatus=${paymentStatus} (providerStatus=${providerStatus})`,
    );

    emitPaymentUpdated({
      orderId,
      userId: order.userId,
      paymentStatus,
    });

    return {
      orderId,
      paymentStatus,
    };
  }

  async adminSetPaymentStatus(orderId, paymentStatus, paymentMethod) {
    const order = await this.orderRepository.findById(orderId);
    if (!order) throw new AppError("Pedido não encontrado.", 404);
    return this.orderRepository.updatePaymentStatus(
      orderId,
      paymentStatus,
      paymentMethod,
    );
  }

  /**
   * Confirmação explícita de pagamento do Checkout Pro.
   * Chamado pelo CheckoutReturnPage quando o MP redireciona de volta com
   * ?status=approved&payment_id=XXX&external_reference=ORDER_ID.
   * Garante que o pedido seja marcado como APROVADO mesmo quando o webhook
   * falha por ter external_reference nulo.
   */
  async confirmCheckoutPayment(orderId, paymentId, user) {
    const order = await this.orderRepository.findById(orderId);
    if (!order) throw new AppError("Pedido não encontrado.", 404);

    // Verifica propriedade: CLIENTE só confirma o próprio pedido
    if (user.role === "CLIENTE" && order.userId !== user.id) {
      throw new AppError("Acesso negado.", 403);
    }

    if (order.paymentStatus === "APROVADO") {
      // Já está pago — retorna sem fazer nada
      return { orderId, paymentStatus: "APROVADO", alreadyPaid: true };
    }

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) throw new AppError("Mercado Pago não configurado.", 500);

    const client = new MercadoPagoConfig({ accessToken: mpToken });
    const paymentApi = new MPPayment(client);
    const payment = await paymentApi.get({ id: String(paymentId) });

    console.log(
      `[confirmCheckout] paymentId=${paymentId} status=${payment.status} ext_ref=${payment.external_reference}`,
    );

    if (payment.status !== "approved" && payment.status !== "authorized") {
      return {
        orderId,
        paymentStatus: PAYMENT_STATUS_MAP[payment.status] ?? "PENDENTE",
        alreadyPaid: false,
      };
    }

    // Verificação de segurança: se o MP retornou external_reference,
    // ele deve bater com o orderId informado.
    if (payment.external_reference && payment.external_reference !== orderId) {
      throw new AppError("Referência do pagamento inválida.", 422);
    }

    // Se external_reference é nulo (bug do MP), valida pelo valor do pedido
    if (!payment.external_reference) {
      const mpAmountCents = toCents(payment.transaction_amount);
      const orderAmountCents = toCents(order.total);
      if (Math.abs(mpAmountCents - orderAmountCents) > 1) {
        throw new AppError("Valor do pagamento não confere com o pedido.", 422);
      }
    }

    await this.paymentRepository.upsertFromWebhook({
      orderId,
      externalId: String(payment.id),
      status: "APROVADO",
      payload: payment,
      amount: order.total,
    });

    await this.orderRepository.updatePaymentStatus(orderId, "APROVADO");

    emitPaymentUpdated({
      orderId,
      userId: order.userId,
      paymentStatus: "APROVADO",
    });

    console.log(`[confirmCheckout] ✅ Pedido ${orderId} marcado como APROVADO`);

    return { orderId, paymentStatus: "APROVADO", alreadyPaid: false };
  }

  async listOrdersByUser(userId) {
    return this.orderRepository.findByUserId(userId);
  }

  async listMotoboyOrders(user) {
    if (user?.role === "MOTOBOY") {
      return this.orderRepository.findForMotoboy({
        assignedMotoboyId: user.id,
      });
    }

    return this.orderRepository.findForMotoboy();
  }

  async listActiveOrders() {
    console.log("[listActiveOrders] start");
    try {
      const orders = await this.orderRepository.findAllActive();
      console.log("[listActiveOrders] repository orders count=", orders.length);

      const filtered = orders.filter((o) => o.status !== "CANCELADO");
      console.log("[listActiveOrders] filtered orders count=", filtered.length);

      if (filtered[0]) {
        console.log("[listActiveOrders] first order snapshot=", {
          id: filtered[0].id,
          status: filtered[0].status,
          paymentStatus: filtered[0].paymentStatus,
          hasUser: Boolean(filtered[0].user),
          hasMesa: Boolean(filtered[0].mesa),
          itemsCount: Array.isArray(filtered[0].items)
            ? filtered[0].items.length
            : 0,
        });
      }

      return filtered;
    } catch (error) {
      console.error("[listActiveOrders] falhou", {
        message: error?.message ?? null,
        code: error?.code ?? null,
        meta: error?.meta ?? null,
      });
      throw error;
    }
  }

  async listPendingPaymentOrders() {
    return this.orderRepository.findPendingPayments();
  }

  async listOrderHistory({ clientName, dateFrom, dateTo } = {}) {
    return this.orderRepository.findAllHistory({
      clientName,
      dateFrom,
      dateTo,
    });
  }

  async getSalesAnalytics({ from, to } = {}) {
    const orders = await this.orderRepository.findAllForAnalytics();
    const now = new Date();
    const todayStart = startOfDay(now);
    const monthStart = startOfMonth(now);

    // Build date range
    let rangeStart = null;
    let rangeEnd = null;
    if (from) {
      rangeStart = new Date(from);
      rangeEnd = new Date(to ?? now);
      rangeEnd.setHours(23, 59, 59, 999);
    }

    // All paid orders (unfiltered) — used for today/month sub-metrics
    const allApprovedOrders = orders.filter(
      (order) => order.paymentStatus === "APROVADO",
    );
    const allPaidOrders = allApprovedOrders.filter(
      (order) => order.status !== "CANCELADO",
    );

    // Paid orders filtered to the selected period — used for main totals
    const paidOrders = rangeStart
      ? allPaidOrders.filter((o) => {
          const d = new Date(o.createdAt);
          return d >= rangeStart && d <= rangeEnd;
        })
      : allPaidOrders;

    const filteredOrders = rangeStart
      ? orders.filter((o) => {
          const d = new Date(o.createdAt);
          return d >= rangeStart && d <= rangeEnd;
        })
      : orders;

    const refundPendingOrders = filteredOrders.filter(
      (order) =>
        order.status === "CANCELADO" && order.paymentStatus === "APROVADO",
    );

    const paidToday = allPaidOrders.filter(
      (order) => new Date(order.createdAt) >= todayStart,
    );
    const paidThisMonth = allPaidOrders.filter(
      (order) => new Date(order.createdAt) >= monthStart,
    );

    // Calcula custo total de um pedido: soma costPrice * quantity de cada item
    const orderCost = (order) =>
      (order.items ?? []).reduce(
        (sum, item) =>
          sum + Number(item.costPrice ?? 0) * Number(item.quantity ?? 1),
        0,
      );

    const totalRevenue = paidOrders.reduce(
      (sum, o) => sum + Number(o.total),
      0,
    );
    const totalCost = paidOrders.reduce((sum, o) => sum + orderCost(o), 0);

    const revenueToday = paidToday.reduce((sum, o) => sum + Number(o.total), 0);
    const costToday = paidToday.reduce((sum, o) => sum + orderCost(o), 0);

    const revenueThisMonth = paidThisMonth.reduce(
      (sum, o) => sum + Number(o.total),
      0,
    );
    const costThisMonth = paidThisMonth.reduce(
      (sum, o) => sum + orderCost(o),
      0,
    );

    const averageTicket = paidOrders.length
      ? totalRevenue / paidOrders.length
      : 0;

    const statusCounts = filteredOrders.reduce((acc, order) => {
      acc[order.status] = (acc[order.status] ?? 0) + 1;
      return acc;
    }, {});

    const paymentMethodLabels = {
      CREDITO: "Crédito",
      DEBITO: "Débito",
      PIX: "Pix",
      DINHEIRO: "Dinheiro",
      mercado_pago: "Mercado Pago",
      nao_informado: "Não informado",
    };

    const paymentMethodMap = new Map();
    for (const order of paidOrders) {
      const method = order.paymentMethod || "nao_informado";
      const current = paymentMethodMap.get(method) ?? {
        method,
        label: paymentMethodLabels[method] ?? method,
        orders: 0,
        revenue: 0,
      };
      current.orders += 1;
      current.revenue += Number(order.total);
      paymentMethodMap.set(method, current);
    }

    const orderTypeMap = new Map([
      ["MESA", { type: "MESA", label: "Mesa", orders: 0, revenue: 0 }],
      ["RETIRADA", { type: "RETIRADA", label: "Retirada", orders: 0, revenue: 0 }],
      ["ENTREGA", { type: "ENTREGA", label: "Entrega", orders: 0, revenue: 0 }],
    ]);
    for (const order of paidOrders) {
      const type = order.mesaId ? "MESA" : order.isPickup ? "RETIRADA" : "ENTREGA";
      const current = orderTypeMap.get(type);
      current.orders += 1;
      current.revenue += Number(order.total);
    }

    // Determine chart range and grouping
    const last7DaysStart = new Date(todayStart);
    last7DaysStart.setDate(last7DaysStart.getDate() - 6);
    const chartFrom = rangeStart ?? last7DaysStart;
    const chartToDate =
      rangeEnd ??
      (() => {
        const d = new Date(now);
        d.setHours(23, 59, 59, 999);
        return d;
      })();
    const diffDays = Math.ceil(
      (chartToDate - chartFrom) / (1000 * 60 * 60 * 24),
    );
    const groupByMonth = diffDays > 60;

    const salesMap = new Map();
    if (groupByMonth) {
      const cur = new Date(chartFrom.getFullYear(), chartFrom.getMonth(), 1);
      const end = new Date(
        chartToDate.getFullYear(),
        chartToDate.getMonth(),
        1,
      );
      while (cur <= end) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
        salesMap.set(key, { revenue: 0, cost: 0 });
        cur.setMonth(cur.getMonth() + 1);
      }
      for (const order of paidOrders) {
        const d = new Date(order.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (salesMap.has(key)) {
          const entry = salesMap.get(key);
          entry.revenue += Number(order.total);
          entry.cost += orderCost(order);
        }
      }
    } else {
      const cur = new Date(chartFrom);
      cur.setHours(0, 0, 0, 0);
      while (cur <= chartToDate) {
        const key = cur.toISOString().slice(0, 10);
        salesMap.set(key, { revenue: 0, cost: 0 });
        cur.setDate(cur.getDate() + 1);
      }
      for (const order of paidOrders) {
        const createdAt = new Date(order.createdAt);
        const key = createdAt.toISOString().slice(0, 10);
        if (salesMap.has(key)) {
          const entry = salesMap.get(key);
          entry.revenue += Number(order.total);
          entry.cost += orderCost(order);
        }
      }
    }

    const topProductsMap = new Map();
    for (const order of paidOrders) {
      for (const item of order.items ?? []) {
        if (item.productName) {
          topProductsMap.set(
            item.productName,
            (topProductsMap.get(item.productName) ?? 0) + Number(item.quantity),
          );
        }
      }
    }

    const topProducts = [...topProductsMap.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    return {
      summary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        totalProfit: Number((totalRevenue - totalCost).toFixed(2)),
        revenueToday: Number(revenueToday.toFixed(2)),
        costToday: Number(costToday.toFixed(2)),
        profitToday: Number((revenueToday - costToday).toFixed(2)),
        revenueThisMonth: Number(revenueThisMonth.toFixed(2)),
        costThisMonth: Number(costThisMonth.toFixed(2)),
        profitThisMonth: Number((revenueThisMonth - costThisMonth).toFixed(2)),
        ordersCount: filteredOrders.length,
        paidOrdersCount: paidOrders.length,
        approvedOrdersCount: paidOrders.length,
        refundPendingCount: refundPendingOrders.length,
        refundPendingTotal: Number(
          refundPendingOrders
            .reduce((sum, order) => sum + Number(order.total), 0)
            .toFixed(2),
        ),
        averageTicket: Number(averageTicket.toFixed(2)),
      },
      statusCounts,
      paymentMethods: [...paymentMethodMap.values()]
        .map((item) => ({
          ...item,
          revenue: Number(item.revenue.toFixed(2)),
        }))
        .sort((a, b) => b.revenue - a.revenue),
      orderTypes: [...orderTypeMap.values()]
        .map((item) => ({
          ...item,
          revenue: Number(item.revenue.toFixed(2)),
        }))
        .filter((item) => item.orders > 0),
      dailySales: [...salesMap.entries()].map(([date, { revenue, cost }]) => ({
        date,
        revenue: Number(revenue.toFixed(2)),
        cost: Number(cost.toFixed(2)),
        profit: Number((revenue - cost).toFixed(2)),
      })),
      topProducts,
    };
  }

  async getOrderById(orderId) {
    const order = await this.orderRepository.findById(orderId);

    if (!order) {
      throw new AppError("Pedido nao encontrado.", 404);
    }

    return order;
  }

  async assignMotoboy(orderId, motoboyId) {
    await this.orderRepository.assignMotoboy(orderId, motoboyId);
  }

  async confirmDelivery(orderId, code, user) {
    try {
      const order = await this.orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);

      if (order.paymentStatus !== "APROVADO") {
        throw new AppError(
          "Pedido precisa estar pago para confirmar a entrega.",
          409,
        );
      }

      if (
        user?.role === "MOTOBOY" &&
        order.assignedMotoboyId &&
        order.assignedMotoboyId !== user.id
      ) {
        throw new AppError("Este pedido está atribuído a outro motoboy.", 403);
      }

      const updatedOrder = await this.orderRepository.confirmDelivery(
        orderId,
        code,
      );
      if (!updatedOrder) throw new AppError("Pedido não encontrado.", 404);
      emitOrderStatusUpdated({
        orderId: updatedOrder.id,
        userId: updatedOrder.userId,
        previousStatus: "SAIU_PARA_ENTREGA",
        status: "ENTREGUE",
      });
      return updatedOrder;
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.message === "CODE_INVALID")
        throw new AppError("Código inválido.", 400);
      if (err.message === "STATUS_INVALID")
        throw new AppError("Pedido não está em trânsito.", 400);
      if (err.message === "IS_PICKUP")
        throw new AppError("Pedido de retirada não usa código.", 400);
      throw err;
    }
  }

  async markPaidByMotoboy(orderId, user, paymentMethod) {
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw new AppError("Pedido não encontrado.", 404);
    }

    if (order.paymentStatus === "APROVADO") {
      return order;
    }

    if (user?.role === "MOTOBOY") {
      if (order.status !== "SAIU_PARA_ENTREGA") {
        throw new AppError(
          "Apenas pedidos em entrega podem ser marcados como pagos.",
          409,
        );
      }

      if (!order.assignedMotoboyId || order.assignedMotoboyId !== user.id) {
        throw new AppError(
          "Apenas o motoboy atribuído pode confirmar pagamento.",
          403,
        );
      }
    } else if (["ADMIN", "FUNCIONARIO", "ATENDENTE"].includes(user?.role)) {
      if (order.status === "CANCELADO") {
        throw new AppError("Pedido cancelado não pode ser pago.", 409);
      }
    } else {
      throw new AppError("Acesso negado.", 403);
    }

    const updatedOrder = await this.orderRepository.updatePaymentStatus(
      orderId,
      "APROVADO",
      paymentMethod,
    );

    emitPaymentUpdated({
      orderId,
      userId: order.userId,
      paymentStatus: "APROVADO",
    });

    return updatedOrder;
  }

  async deleteOrder(orderId, userId) {
    const row = await this.orderRepository.findOwnerAndStatus(orderId);
    if (!row) throw new AppError("Pedido nao encontrado.", 404);
    if (row.userId !== userId) throw new AppError("Acesso negado.", 403);
    if (row.status !== "CANCELADO") {
      throw new AppError(
        "Somente pedidos cancelados podem ser excluidos.",
        422,
      );
    }
    await this.orderRepository.deleteById(orderId, userId);
  }

  #isMissingColumnError(error) {
    const code = String(error?.code ?? "").toUpperCase();
    const dbCode = String(error?.meta?.code ?? "").toUpperCase();
    const message = String(error?.message ?? "").toLowerCase();

    return (
      code === "P2022" ||
      code === "42703" ||
      dbCode === "42703" ||
      message.includes("does not exist")
    );
  }

  async #getTableColumns(tx, tableName) {
    const rows = await tx.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    `;

    return new Set(rows.map((row) => row.column_name));
  }

  #buildOrderDataForColumns(orderData, orderColumns) {
    const scalarEntries = Object.entries(orderData).filter(
      ([key]) => key !== "items" && key !== "payment",
    );

    const compatibleScalars = Object.fromEntries(
      scalarEntries.filter(([key]) => orderColumns.has(key)),
    );

    return {
      ...compatibleScalars,
      ...(orderData.items ? { items: orderData.items } : {}),
      ...(orderData.payment ? { payment: orderData.payment } : {}),
    };
  }

  async #normalizeItemInTransaction(tx, item) {
    const quantity = item.quantity ?? 1;
    if (!item.productId) {
      throw new AppError("Item exige productId.", 422);
    }

    const product = await tx.product.findFirst({
      where: {
        id: item.productId,
        isActive: true,
      },
      include: {
        sizes: {
          ...(item.size ? { where: { size: item.size } } : {}),
          orderBy: {
            price: "asc",
          },
          take: 1,
        },
      },
    });

    if (!product) {
      throw new AppError("Produto invalido ou inativo.", 422);
    }

    const basePrice = product.sizes?.[0]?.price;
    if (basePrice == null) {
      throw new AppError("Produto sem preco configurado.", 422);
    }

    const addonIds = [...new Set(item.addonIds ?? [])];
    let addons = [];
    let addonsCents = 0;

    if (addonIds.length > 0) {
      const addonRows = await tx.addon.findMany({
        where: {
          id: {
            in: addonIds,
          },
          isActive: true,
        },
      });

      if (addonRows.length !== addonIds.length) {
        throw new AppError("Um ou mais adicionais sao invalidos.", 422);
      }

      addons = addonRows.map((addon) => ({
        id: addon.id,
        name: addon.name,
        price: Number(addon.price),
      }));

      addonsCents = addonRows.reduce(
        (sum, addon) => sum + toCents(addon.price),
        0,
      );
    }

    const unitPriceCents = toCents(basePrice) + addonsCents;
    const totalPriceCents = unitPriceCents * quantity;

    return {
      productId: item.productId,
      quantity,
      unitPriceCents,
      totalPriceCents,
      addons,
      removedIngredients: item.removedIngredients ?? null,
      notes: item.notes ?? null,
    };
  }

  async #findOrderIdByTerminalReferences(paymentData) {
    const rawCandidates = [
      paymentData?.order?.id,
      paymentData?.point_of_interaction?.transaction_data?.order_id,
      paymentData?.point_of_interaction?.transaction_data
        ?.external_resource_url,
      paymentData?.metadata?.order_id,
      paymentData?.metadata?.external_reference,
      paymentData?.additional_info?.external_reference,
    ].filter(Boolean);

    const normalizedCandidates = [
      ...new Set(
        rawCandidates.flatMap((candidate) => {
          const value = String(candidate).trim();
          if (!value) return [];

          const orderMatch = value.match(/\/v1\/orders\/([A-Z0-9]+)/i);
          return [orderMatch?.[1] ?? value];
        }),
      ),
    ];

    for (const candidate of normalizedCandidates) {
      if (!candidate || isMercadoPagoInternalReference(candidate)) continue;

      const orderByIntent =
        await this.orderRepository.findByTerminalIntentId?.(candidate);
      if (orderByIntent?.id) {
        console.log(
          "[webhook] Pedido localizado por terminalIntentId:",
          candidate,
          "->",
          orderByIntent.id,
        );
        return orderByIntent.id;
      }
    }

    return null;
  }
}
