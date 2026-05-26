import crypto from "crypto";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { OrderService } from "../services/OrderService.js";
import {
  createOrderSchema,
  paymentWebhookSchema,
  updateOrderStatusSchema,
} from "../validators/orderSchemas.js";

const orderService = new OrderService();

export class OrderController {
  async create(req, res, next) {
    try {
      const payload = createOrderSchema.parse(req.body);
      const isMesa = req.user.role === "MESA";
      const isStaffMesaOrder =
        Boolean(req.params?.mesaId) &&
        ["ADMIN", "FUNCIONARIO", "ATENDENTE"].includes(req.user.role);
      const isStaffComandaOrder =
        Boolean(req.params?.comandaId) &&
        ["ADMIN", "FUNCIONARIO", "ATENDENTE"].includes(req.user.role);
      const order = await orderService.createOrder({
        ...(isMesa
          ? { mesaId: req.user.id }
          : isStaffMesaOrder
            ? { mesaId: req.params.mesaId }
            : isStaffComandaOrder
              ? { comandaId: req.params.comandaId }
            : { userId: req.user.id }),
        ...payload,
      });

      return res.status(201).json({
        message: "Pedido criado com sucesso.",
        data: order,
      });
    } catch (error) {
      return this.#handleError(error, next, {
        route: "POST /api/orders",
        userId: req.user?.id,
        role: req.user?.role,
        bodySummary: {
          hasDeliveryAddress: Boolean(req.body?.deliveryAddress),
          isPickup: req.body?.isPickup,
          paymentMethod: req.body?.paymentMethod,
          itemsCount: Array.isArray(req.body?.items)
            ? req.body.items.length
            : 0,
          firstItem: Array.isArray(req.body?.items) ? req.body.items[0] : null,
        },
      });
    }
  }

  async updateStatus(req, res, next) {
    try {
      const { status } = updateOrderStatusSchema.parse(req.body);
      const updatedOrder = await orderService.updateOrderStatus(
        req.params.orderId,
        status,
      );

      return res.status(200).json({
        message: "Status do pedido atualizado.",
        data: updatedOrder,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async getById(req, res, next) {
    try {
      const order = await orderService.getOrderById(req.params.orderId);

      return res.status(200).json({
        data: order,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async getMyOrders(req, res, next) {
    try {
      const orders = await orderService.listOrdersByUser(req.user.id);

      return res.status(200).json({
        data: orders,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async listAll(_req, res, next) {
    try {
      const orders = await orderService.listActiveOrders();

      return res.status(200).json({
        data: orders,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async pendingPayments(_req, res, next) {
    try {
      const orders = await orderService.listPendingPaymentOrders();

      return res.status(200).json({
        data: orders,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async motoboyOrders(req, res, next) {
    try {
      const orders = await orderService.listMotoboyOrders(req.user);
      return res.status(200).json({ data: orders });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async history(req, res, next) {
    try {
      const { clientName, dateFrom, dateTo } = req.query;
      const orders = await orderService.listOrderHistory({
        clientName: clientName || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      return res.status(200).json({ data: orders });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async cancel(req, res, next) {
    try {
      const updatedOrder = await orderService.cancelOrder(req.params.orderId);

      return res.status(200).json({
        message: "Pedido cancelado.",
        data: updatedOrder,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async analytics(req, res, next) {
    try {
      const { from, to } = req.query;
      const analytics = await orderService.getSalesAnalytics({ from, to });

      return res.status(200).json({
        data: analytics,
      });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async adminUpdatePaymentStatus(req, res, next) {
    try {
      const { paymentStatus } = req.body;
      const paymentMethod = req.body?.paymentMethod;
      const payLater = req.body?.payLater === true;
      const ALLOWED = ["APROVADO", "PENDENTE", "RECUSADO", "ESTORNADO"];
      const ALLOWED_METHODS = ["CREDITO", "DEBITO", "PIX", "DINHEIRO"];
      if (!ALLOWED.includes(paymentStatus)) {
        throw new AppError("paymentStatus inválido.", 422);
      }
      if (paymentStatus === "APROVADO" && !paymentMethod) {
        throw new AppError("Escolha a forma de pagamento.", 422);
      }
      if (
        paymentStatus === "APROVADO" &&
        paymentMethod !== undefined &&
        !ALLOWED_METHODS.includes(paymentMethod)
      ) {
        throw new AppError("paymentMethod inválido.", 422);
      }
      const order = await orderService.adminSetPaymentStatus(
        req.params.orderId,
        paymentStatus,
        paymentStatus === "APROVADO"
          ? paymentMethod
          : payLater && paymentStatus === "PENDENTE"
            ? "PAGAR_DEPOIS"
            : undefined,
      );
      return res
        .status(200)
        .json({ message: "Status de pagamento atualizado.", data: order });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async confirmCheckoutPayment(req, res, next) {
    try {
      const { orderId, paymentId } = req.body;
      if (!orderId || !paymentId) {
        throw new AppError("orderId e paymentId são obrigatórios.", 422);
      }
      const result = await orderService.confirmCheckoutPayment(
        orderId,
        String(paymentId),
        req.user,
      );
      return res.status(200).json({ data: result });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async paymentWebhook(req, res, next) {
    const ts = new Date().toISOString();
    console.log(`\n[webhook] ========== RECEBIDO ${ts} ==========`);
    console.log(
      "[webhook] headers type:",
      req.headers["x-signature"] ? "com x-signature" : "sem x-signature",
    );
    console.log("[webhook] query:", JSON.stringify(req.query));
    console.log("[webhook] raw body:", JSON.stringify(req.body));

    // \u2500\u2500 Verifica\u00e7\u00e3o HMAC-SHA256 da assinatura do Mercado Pago \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // MP_WEBHOOK_SECRET \u00e9 o "chave secreta" gerado no painel do MP para este webhook.
    // Formato do header: x-signature: ts=TIMESTAMP,v1=HMAC
    // Formato do template: id:{paymentId};request-id:{xRequestId};ts:{timestamp}
    if (process.env.MP_WEBHOOK_SECRET) {
      const xSignature = req.headers["x-signature"] || "";
      const xRequestId = req.headers["x-request-id"] || "";
      const dataId =
        req.query["data.id"] || req.query.id || req.body?.data?.id || "";

      const tsPart = xSignature.split(",").find((p) => p.startsWith("ts="));
      const v1Part = xSignature.split(",").find((p) => p.startsWith("v1="));

      if (!tsPart || !v1Part) {
        console.warn(
          "[webhook] HMAC: header x-signature ausente ou mal-formado. Ignorando.",
        );
      } else {
        const timestamp = tsPart.slice(3);
        const receivedHmac = v1Part.slice(3);
        const template = `id:${dataId};request-id:${xRequestId};ts:${timestamp}`;
        const expectedHmac = crypto
          .createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
          .update(template)
          .digest("hex");

        if (
          receivedHmac.length !== expectedHmac.length ||
          !crypto.timingSafeEqual(
            Buffer.from(receivedHmac),
            Buffer.from(expectedHmac),
          )
        ) {
          console.error(
            "[webhook] HMAC inválido! Possível webhook falso bloqueado.",
          );
          return res.status(200).json({ message: "OK" }); // 200 para evitar retry, mas não processa
        }
        console.log("[webhook] HMAC verificado com sucesso.");
      }
    }
    // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

    try {
      // Mescla query params + body para suportar IPN (query string) e Webhook (body) simultaneamente.
      // IPN legado: POST /webhook?id=123&topic=payment (body vazio)
      // Webhook moderno: POST /webhook com JSON no body
      // Body tem prioridade sobre query em caso de conflito.
      const rawPayload = { ...req.query, ...req.body };
      const payload = paymentWebhookSchema.parse(rawPayload);

      // Responde 200 imediatamente ao Mercado Pago (obrigatório — evita retries em loop)
      res.status(200).json({ message: "OK" });

      // Processa em background sem bloquear a resposta
      orderService.handlePaymentWebhook(payload).catch((err) => {
        console.error(
          "[webhook] Erro ao processar payload em background:",
          err.message,
          err.stack,
        );
      });
    } catch (error) {
      // Mesmo em caso de parse error, responde 200 para evitar retry do MP
      res.status(200).json({ message: "OK" });
      console.error(
        "[webhook] Parse error:",
        error.message,
        "body:",
        JSON.stringify(req.body),
      );
    }
  }

  async assignMotoboy(req, res, next) {
    try {
      const { motoboyId } = req.body;
      if (!motoboyId || typeof motoboyId !== "string") {
        throw new AppError("motoboyId é obrigatório.", 422);
      }
      await orderService.assignMotoboy(req.params.orderId, motoboyId);
      return res.status(200).json({ message: "Motoboy atribuído." });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async deleteOrder(req, res, next) {
    try {
      await orderService.deleteOrder(req.params.orderId, req.user.id);
      return res.status(200).json({ message: "Pedido excluido com sucesso." });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async confirmDelivery(req, res, next) {
    try {
      const { code } = req.body;
      if (!code || typeof code !== "string") {
        throw new AppError("Código é obrigatório.", 422);
      }
      const normalizedCode = code.trim();
      if (!/^\d{4}$/.test(normalizedCode)) {
        throw new AppError("Código deve ter 4 números.", 422);
      }

      const order = await orderService.confirmDelivery(
        req.params.orderId,
        normalizedCode,
        req.user,
      );
      return res
        .status(200)
        .json({ message: "Entrega confirmada.", data: order });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async markPaid(req, res, next) {
    try {
      const paymentMethod = req.body?.paymentMethod;
      const ALLOWED_METHODS = ["CREDITO", "DEBITO", "PIX", "DINHEIRO"];
      if (!ALLOWED_METHODS.includes(paymentMethod)) {
        throw new AppError("Escolha a forma de pagamento.", 422);
      }
      const order = await orderService.markPaidByMotoboy(
        req.params.orderId,
        req.user,
        paymentMethod,
      );
      return res
        .status(200)
        .json({ message: "Pagamento confirmado.", data: order });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  #handleError(error, next, context = null) {
    if (error instanceof ZodError) {
      console.warn("[OrderController] Zod validation error", {
        context,
        issues: error.issues,
        flattened: error.flatten(),
      });
      return next(new AppError("Payload invalido.", 422, error.flatten()));
    }

    if (error instanceof AppError) {
      console.warn("[OrderController] AppError", {
        context,
        statusCode: error.statusCode,
        message: error.message,
        details: error.details ?? null,
      });
    }

    return next(error);
  }
}
