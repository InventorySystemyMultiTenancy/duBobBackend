import {
  MercadoPagoConfig,
  Preference,
  Payment as MPPayment,
} from "mercadopago";
import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { MesaRepository } from "../repositories/MesaRepository.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { TotemService } from "../services/TotemService.js";
import { OrderService } from "../services/OrderService.js";
import {
  StonePaymentService,
  isStoneIntent,
} from "../services/StonePaymentService.js";
import {
  PaymentSettingsService,
  PAYMENT_PROVIDERS,
} from "../services/PaymentSettingsService.js";
import {
  SumUpPaymentService,
  isSumUpIntent,
} from "../services/SumUpPaymentService.js";

const orderRepository = new OrderRepository();
const mesaRepository = new MesaRepository();
const appSettingRepository = new AppSettingRepository();
const totemService = new TotemService();
const orderService = new OrderService();
const paymentSettingsService = new PaymentSettingsService();
const sumUpPaymentService = new SumUpPaymentService();
const stonePaymentService = new StonePaymentService();

export class PaymentController {
  // Pagamento online do delivery pela SumUp: { method: "PIX" | "CARTAO" }.
  async createSumUpOnlinePayment(req, res, next) {
    try {
      const { orderId, method } = req.body;
      if (!orderId) throw new AppError("orderId obrigatório.", 422);
      if (!["PIX", "CARTAO"].includes(method)) {
        throw new AppError("Forma de pagamento inválida.", 422);
      }

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);
      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }
      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido já pago.", 409);
      }

      const provider = await paymentSettingsService.getProvider("online");
      if (provider !== PAYMENT_PROVIDERS.SUMUP) {
        throw new AppError("O pagamento online não está configurado para a SumUp.", 422);
      }

      const data =
        method === "PIX"
          ? await sumUpPaymentService.startOnlinePix(order)
          : await sumUpPaymentService.startOnlineCard(order);
      return res.status(200).json({ data });
    } catch (error) {
      return next(error);
    }
  }

  async createPreference(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) {
        throw new AppError("orderId obrigatório.", 422);
      }

      const order = await orderRepository.findById(orderId);

      if (!order) {
        throw new AppError("Pedido não encontrado.", 404);
      }

      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }

      const accessToken = process.env.MP_ACCESS_TOKEN;
      if (!accessToken) {
        throw new AppError("Mercado Pago não configurado.", 500);
      }

      const client = new MercadoPagoConfig({ accessToken });
      const preferenceApi = new Preference(client);

      const frontendUrl =
        process.env.FRONTEND_URL ||
        "https://dubob.selfmachine.com.br";

      const preference = await preferenceApi.create({
        body: {
          items: [
            {
              id: order.id,
              title: "Pedido Dubob",
              description: `Pedido #${order.id.slice(-6).toUpperCase()}`,
              quantity: 1,
              unit_price: parseFloat(Number(order.total).toFixed(2)),
              currency_id: "BRL",
            },
          ],
          external_reference: order.id,
          back_urls: {
            success: `${frontendUrl}/checkout/retorno`,
            failure: `${frontendUrl}/checkout/retorno`,
            pending: `${frontendUrl}/checkout/retorno`,
          },
          auto_return: "approved",
          notification_url: `${process.env.BACKEND_URL || "https://dubobbackend.onrender.com"}/api/payments/webhook`,
          statement_descriptor: "DUBOB",
        },
      });

      return res.status(200).json({
        data: {
          preferenceId: preference.id,
          initPoint: preference.init_point,
          sandboxInitPoint: preference.sandbox_init_point,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Gera QR code PIX via MP Payment API (para pagamento na mesa/tablet)
  async createMesaPixPayment(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) throw new AppError("orderId obrigatório.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);

      // Apenas a propria mesa ou admin pode iniciar o pagamento
      const isMesa = req.user.role === "MESA";
      if (isMesa && order.mesaId !== req.user.id) {
        throw new AppError("Acesso negado.", 403);
      }
      if (
        !isMesa &&
        req.user.role !== "ADMIN" &&
        req.user.role !== "FUNCIONARIO" &&
        req.user.role !== "ATENDENTE"
      ) {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido já pago.", 409);
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago não configurado.", 500);

      const client = new MercadoPagoConfig({ accessToken: mpToken });
      const paymentApi = new MPPayment(client);

      const response = await paymentApi.create({
        body: {
          transaction_amount: parseFloat(Number(order.total).toFixed(2)),
          payment_method_id: "pix",
          payer: {
            email: process.env.MP_PIX_PAYER_EMAIL || "mesa@dubob.com",
          },
          description: `Pedido Mesa #${order.id.slice(-6).toUpperCase()}`,
          external_reference: order.id,
          notification_url: `${process.env.BACKEND_URL || "https://dubobbackend.onrender.com"}/api/payments/webhook`,
        },
      });

      const txData = response.point_of_interaction?.transaction_data ?? {};

      return res.status(200).json({
        data: {
          paymentId: response.id,
          status: response.status,
          qrCode: txData.qr_code,
          qrCodeBase64: txData.qr_code_base64,
          expiresAt: txData.ticket_url,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Envia cobrança direto para a maquininha (MP Point — API unificada /v1/orders)
  async createMesaTerminalPayment(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) throw new AppError("orderId obrigatório.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);

      if (!order.mesaId) {
        throw new AppError("Pedido não vinculado a uma mesa.", 422);
      }

      const isMesa = req.user.role === "MESA";
      if (isMesa && order.mesaId !== req.user.id) {
        throw new AppError("Acesso negado.", 403);
      }
      if (
        !isMesa &&
        req.user.role !== "ADMIN" &&
        req.user.role !== "FUNCIONARIO" &&
        req.user.role !== "ATENDENTE"
      ) {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido já pago.", 409);
      }

      const provider = await paymentSettingsService.getProvider("terminal");
      if (provider === PAYMENT_PROVIDERS.SUMUP) {
        const mesa = await mesaRepository.findById(order.mesaId);
        if (!mesa?.terminalId) {
          throw new AppError("Mesa sem maquininha configurada.", 422);
        }
        // Na SumUp o "ID da maquininha" é o usuário SumUp logado nela.
        const data = await sumUpPaymentService.startTerminalCharge(
          order,
          mesa.terminalId,
        );
        return res.status(200).json({ data });
      }
      if (provider === PAYMENT_PROVIDERS.STONE) {
        const mesa = await mesaRepository.findById(order.mesaId);
        if (!mesa?.terminalId) {
          throw new AppError("Mesa sem maquininha configurada.", 422);
        }
        // Na Stone o "ID da maquininha" é o número de série dela.
        const data = await stonePaymentService.startTerminalCharge(
          order,
          mesa.terminalId,
          `Mesa ${mesa.number} #${order.id.slice(-6).toUpperCase()}`,
        );
        return res.status(200).json({ data });
      }

      // Se já existe um terminalIntentId salvo, cancela a cobrança anterior
      // antes de criar uma nova — evita múltiplas cobranças na maquininha.
      if (
        order.terminalIntentId &&
        !isSumUpIntent(order.terminalIntentId) &&
        !isStoneIntent(order.terminalIntentId)
      ) {
        const mpToken0 = process.env.MP_ACCESS_TOKEN;
        if (mpToken0) {
          try {
            // Cancela a MP Order anterior (se ainda estiver em estado cancelável)
            const cancelResp = await fetch(
              `https://api.mercadopago.com/v1/orders/${order.terminalIntentId}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${mpToken0}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ status: "canceled" }),
              },
            );
            if (cancelResp.ok) {
              console.log(
                `[createMesaTerminalPayment] Intent anterior cancelada: ${order.terminalIntentId}`,
              );
            } else {
              const errBody = await cancelResp.json().catch(() => ({}));
              console.warn(
                `[createMesaTerminalPayment] Não foi possível cancelar intent anterior ${order.terminalIntentId}:`,
                errBody?.message,
              );
            }
          } catch (e) {
            console.warn(
              `[createMesaTerminalPayment] Erro ao cancelar intent anterior:`,
              e.message,
            );
          }
        }
      }

      const mesa = await mesaRepository.findById(order.mesaId);
      if (!mesa?.terminalId) {
        throw new AppError("Mesa sem maquininha configurada.", 422);
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago não configurado.", 500);

      // Nova API unificada do MP Point: POST /v1/orders
      // external_reference fica na raiz e é propagado ao webhook automaticamente.
      const orderBody = {
        type: "point",
        external_reference: order.id,
        description: `Pedido Mesa ${mesa.number} #${order.id.slice(-6).toUpperCase()}`,
        transactions: {
          payments: [
            {
              amount: Number(order.total).toFixed(2),
            },
          ],
        },
        config: {
          point: {
            terminal_id: mesa.terminalId,
            print_on_terminal: "no_ticket",
          },
        },
      };

      console.log("[createMesaTerminalPayment] terminalId:", mesa.terminalId);
      console.log(
        "[createMesaTerminalPayment] body:",
        JSON.stringify(orderBody),
      );

      const idempotencyKey = `${order.id}-${Date.now()}`;

      const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mpToken}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(orderBody),
      });

      if (!mpResponse.ok) {
        const errBody = await mpResponse.json().catch(() => ({}));
        console.error(
          "[createMesaTerminalPayment] MP error:",
          JSON.stringify(errBody),
        );
        throw new AppError(
          errBody?.message || "Erro ao enviar para a maquininha.",
          mpResponse.status >= 500 ? 502 : 422,
        );
      }

      const mpOrder = await mpResponse.json();
      console.log(
        "[createMesaTerminalPayment] MP order criada:",
        mpOrder.id,
        "| status:",
        mpOrder.status,
      );

      // Salva o orderId do MP para rastrear no webhook
      if (mpOrder.id) {
        try {
          await orderRepository.saveTerminalIntentId(order.id, mpOrder.id);
          console.log(
            "[createMesaTerminalPayment] MP orderId salvo:",
            mpOrder.id,
            "-> orderId:",
            order.id,
          );
        } catch (e) {
          console.warn(
            "[createMesaTerminalPayment] Falha ao salvar MP orderId:",
            e.message,
          );
        }
      }

      return res.status(200).json({
        data: {
          intentId: mpOrder.id,
          deviceId: mesa.terminalId,
          status: mpOrder.status,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async createTotemTerminalPayment(req, res, next) {
    try {
      const { orderId, totemId, totemSlug } = req.body;

      if (!orderId) throw new AppError("orderId obrigatório.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);

      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pedido já pago.", 409);
      }

      const totem =
        totemId || totemSlug
          ? await totemService.findByPaymentRef({ totemId, totemSlug })
          : null;
      const provider = await paymentSettingsService.getProvider("terminal");
      if (provider === PAYMENT_PROVIDERS.STONE) {
        const serial = totem?.stoneSerialNumber?.trim() || totem?.terminalId?.trim();
        const data = await stonePaymentService.startTerminalCharge(
          order,
          serial,
          `${totem?.name ?? "Totem"} #${order.id.slice(-6).toUpperCase()}`,
        );
        return res.status(200).json({ data });
      }

      if (provider === PAYMENT_PROVIDERS.SUMUP && totem?.sumupOperatorId) {
        // Maquininha SumUp escolhida no cadastro do totem.
        const data = await sumUpPaymentService.startTerminalChargeForOperator(
          order,
          totem.sumupOperatorId,
        );
        return res.status(200).json({ data });
      }

      let terminalId = totem?.terminalId?.trim();

      if (!terminalId) {
        const terminalSetting = await appSettingRepository.get(
          "totem_terminal_id",
        );
        terminalId = terminalSetting?.value?.trim();
      }

      if (!terminalId) throw new AppError("Totem sem maquininha configurada.", 422);

      if (provider === PAYMENT_PROVIDERS.SUMUP) {
        const data = await sumUpPaymentService.startTerminalCharge(
          order,
          terminalId,
        );
        return res.status(200).json({ data });
      }

      if (
        order.terminalIntentId &&
        !isSumUpIntent(order.terminalIntentId) &&
        !isStoneIntent(order.terminalIntentId)
      ) {
        const mpToken0 = process.env.MP_ACCESS_TOKEN;
        if (mpToken0) {
          try {
            const cancelResp = await fetch(
              `https://api.mercadopago.com/v1/orders/${order.terminalIntentId}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${mpToken0}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ status: "canceled" }),
              },
            );

            if (!cancelResp.ok) {
              const errBody = await cancelResp.json().catch(() => ({}));
              console.warn(
                "[createTotemTerminalPayment] Não foi possivel cancelar intent anterior:",
                errBody?.message,
              );
            }
          } catch (e) {
            console.warn(
              "[createTotemTerminalPayment] Erro ao cancelar intent anterior:",
              e.message,
            );
          }
        }
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago não configurado.", 500);

      const orderBody = {
        type: "point",
        external_reference: order.id,
        description: `Pedido ${totem?.name ?? "Totem"} #${order.id.slice(-6).toUpperCase()}`,
        transactions: {
          payments: [
            {
              amount: Number(order.total).toFixed(2),
            },
          ],
        },
        config: {
          point: {
            terminal_id: terminalId,
            print_on_terminal: "no_ticket",
          },
        },
      };

      const idempotencyKey = `totem-${order.id}-${Date.now()}`;
      const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mpToken}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(orderBody),
      });

      if (!mpResponse.ok) {
        const errBody = await mpResponse.json().catch(() => ({}));
        console.error(
          "[createTotemTerminalPayment] MP error:",
          JSON.stringify(errBody),
        );
        throw new AppError(
          errBody?.message || "Erro ao enviar para a maquininha.",
          mpResponse.status >= 500 ? 502 : 422,
        );
      }

      const mpOrder = await mpResponse.json();

      if (mpOrder.id) {
        await orderRepository.saveTerminalIntentId(order.id, mpOrder.id);
      }

      return res.status(200).json({
        data: {
          intentId: mpOrder.id,
          deviceId: terminalId,
          status: mpOrder.status,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  // Cliente desistiu na tela "Aguardando pagamento na maquininha" do totem.
  // Só cancela o pedido se a cobrança na maquininha também for cancelada,
  // para o cliente não pagar um pedido que já foi cancelado.
  async cancelTotemTerminalPayment(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) throw new AppError("orderId obrigatório.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido não encontrado.", 404);

      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }

      if (order.paymentStatus === "APROVADO") {
        throw new AppError("Pagamento já aprovado. O pedido não pode ser cancelado.", 409);
      }

      if (order.status === "CANCELADO") {
        return res.status(200).json({ data: order, message: "Pedido já cancelado." });
      }

      if (isStoneIntent(order.terminalIntentId)) {
        // Tira o pedido da tela da maquininha Stone e confere se já foi pago
        // antes de cancelar (a checagem abaixo barra se aprovou).
        const closed = await stonePaymentService.cancelTerminalCharge(order);
        if (!closed) {
          throw new AppError(
            "Não foi possível cancelar na maquininha. Cancele na própria maquininha ou chame um atendente.",
            409,
          );
        }
        await stonePaymentService.syncAwaitingOrders().catch((e) =>
          console.warn("[cancelTotemTerminalPayment] Stone:", e.message),
        );
      } else if (isSumUpIntent(order.terminalIntentId)) {
        // Fecha a cobrança na tela da maquininha (se foi enviada) e confere se
        // a venda já entrou antes de cancelar (a checagem abaixo barra se aprovou).
        const closed = await sumUpPaymentService.cancelTerminalCharge(order);
        if (!closed) {
          throw new AppError(
            "Não foi possível cancelar na maquininha. Cancele na própria maquininha ou chame um atendente.",
            409,
          );
        }
        await sumUpPaymentService.syncAwaitingOrders().catch((e) =>
          console.warn("[cancelTotemTerminalPayment] SumUp:", e.message),
        );
      } else if (order.terminalIntentId) {
        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) throw new AppError("Mercado Pago não configurado.", 500);

        const mpHeaders = {
          Authorization: `Bearer ${mpToken}`,
          "Content-Type": "application/json",
        };
        const cancelResp = await fetch(
          `https://api.mercadopago.com/v1/orders/${order.terminalIntentId}/cancel`,
          {
            method: "POST",
            headers: {
              ...mpHeaders,
              "X-Idempotency-Key": `totem-cancel-${order.id}-${order.terminalIntentId}`,
            },
          },
        );

        if (!cancelResp.ok) {
          // Pode já estar cancelada/expirada; nesse caso segue com o cancelamento.
          const statusResp = await fetch(
            `https://api.mercadopago.com/v1/orders/${order.terminalIntentId}`,
            { headers: mpHeaders },
          );
          const mpOrder = await statusResp.json().catch(() => ({}));
          const closed = ["canceled", "expired", "failed", "refunded"].includes(
            mpOrder?.status,
          );

          if (!closed) {
            const errBody = await cancelResp.json().catch(() => ({}));
            console.warn(
              "[cancelTotemTerminalPayment] MP não cancelou:",
              mpOrder?.status,
              errBody?.message,
            );
            throw new AppError(
              "Não foi possível cancelar na maquininha. Cancele na própria maquininha ou chame um atendente.",
              409,
            );
          }
        }
      }

      // O webhook pode ter aprovado enquanto cancelávamos.
      const latest = await orderRepository.findById(order.id);
      if (latest?.paymentStatus === "APROVADO") {
        throw new AppError("Pagamento já aprovado. O pedido não pode ser cancelado.", 409);
      }

      const cancelled = await orderService.cancelOrder(order.id);

      return res.status(200).json({ data: cancelled, message: "Pagamento cancelado." });
    } catch (error) {
      return next(error);
    }
  }
}
