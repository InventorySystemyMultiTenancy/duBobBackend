import {
  MercadoPagoConfig,
  Preference,
  Payment as MPPayment,
} from "mercadopago";
import { AppError } from "../errors/AppError.js";
import { OrderRepository } from "../repositories/OrderRepository.js";
import { MesaRepository } from "../repositories/MesaRepository.js";

const orderRepository = new OrderRepository();
const mesaRepository = new MesaRepository();

export class PaymentController {
  async createPreference(req, res, next) {
    try {
      const { orderId } = req.body;

      if (!orderId) {
        throw new AppError("orderId obrigatorio.", 422);
      }

      const order = await orderRepository.findById(orderId);

      if (!order) {
        throw new AppError("Pedido nao encontrado.", 404);
      }

      if (order.userId !== req.user.id && req.user.role !== "ADMIN") {
        throw new AppError("Acesso negado.", 403);
      }

      const accessToken = process.env.MP_ACCESS_TOKEN;
      if (!accessToken) {
        throw new AppError("Mercado Pago nao configurado.", 500);
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
          notification_url: `${process.env.BACKEND_URL || "https://dubob-backend.onrender.com"}/api/payments/webhook`,
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

      if (!orderId) throw new AppError("orderId obrigatorio.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido nao encontrado.", 404);

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
        throw new AppError("Pedido ja pago.", 409);
      }

      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) throw new AppError("Mercado Pago nao configurado.", 500);

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
          notification_url: `${process.env.BACKEND_URL || "https://dubob-backend.onrender.com"}/api/payments/webhook`,
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

      if (!orderId) throw new AppError("orderId obrigatorio.", 422);

      const order = await orderRepository.findById(orderId);
      if (!order) throw new AppError("Pedido nao encontrado.", 404);

      if (!order.mesaId) {
        throw new AppError("Pedido nao vinculado a uma mesa.", 422);
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
        throw new AppError("Pedido ja pago.", 409);
      }

      // Se já existe um terminalIntentId salvo, cancela a cobrança anterior
      // antes de criar uma nova — evita múltiplas cobranças na maquininha.
      if (order.terminalIntentId) {
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
      if (!mpToken) throw new AppError("Mercado Pago nao configurado.", 500);

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
}
