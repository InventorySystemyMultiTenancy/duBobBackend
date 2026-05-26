import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import twilio from "twilio";
import { AuthController } from "./controllers/AuthController.js";
import { OrderController } from "./controllers/OrderController.js";
import { PaymentController } from "./controllers/PaymentController.js";
import { ProductController } from "./controllers/ProductController.js";
import { MesaController } from "./controllers/MesaController.js";
import { ComandaController } from "./controllers/ComandaController.js";
import {
  authenticateToken,
  authorizeRoles,
  enforceOrderOwnership,
} from "./middlewares/authMiddleware.js";
import { errorMiddleware } from "./middlewares/errorMiddleware.js";
import { prisma } from "./lib/prisma.js";
import { DeliveryService } from "./services/DeliveryService.js";
import { deliveryFreightSchema } from "./validators/orderSchemas.js";
import { emitChamarGarcom } from "./realtime/socketServer.js";
import { AppSettingRepository } from "./repositories/AppSettingRepository.js";

// ── Variáveis de ambiente críticas ───────────────────────────────────────────
const REQUIRED_ENV = ["JWT_SECRET", "DATABASE_URL"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(
      `[FATAL] Variável de ambiente obrigatória não definida: ${key}`,
    );
    process.exit(1);
  }
}

if (!process.env.MP_WEBHOOK_SECRET) {
  console.warn(
    "[SECURITY] MP_WEBHOOK_SECRET não definido. Verificação HMAC do webhook desabilitada.",
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);
const authController = new AuthController();
const orderController = new OrderController();
const paymentController = new PaymentController();
const productController = new ProductController();
const mesaController = new MesaController();
const comandaController = new ComandaController();
const appSettingRepository = new AppSettingRepository();

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

// ── Segurança: headers HTTP ───────────────────────────────────────────────────
app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, Render health checks)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);

// Limita tamanho do body para evitar DoS por payloads gigantes
app.use(express.json({ limit: "1mb" }));

// ── Rate limiting: anti brute-force ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // max 20 tentativas por IP por janela
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: "Muitas tentativas. Tente novamente em 15 minutos." },
  },
});
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

app.post("/api/send-order-alert", async (req, res, next) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromInput =
      process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
    const defaultTo = process.env.TWILIO_WHATSAPP_TO;

    if (!accountSid || !authToken) {
      return res.status(500).json({
        error: {
          message:
            "Defina TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN no arquivo .env.",
        },
      });
    }

    const toInput = (req.body?.to || defaultTo || "").trim();
    const body =
      req.body?.message?.trim() ||
      "Ola! Seu pedido da Dubob ja esta sendo preparado!";

    if (!toInput) {
      return res.status(400).json({
        error: {
          message:
            "Informe o destino em req.body.to ou configure TWILIO_WHATSAPP_TO no .env.",
        },
      });
    }

    const to = toInput.startsWith("whatsapp:")
      ? toInput
      : `whatsapp:${toInput}`;
    const from = fromInput.startsWith("whatsapp:")
      ? fromInput
      : `whatsapp:${fromInput}`;

    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      from,
      to,
      body,
    });

    return res.status(200).json({
      ok: true,
      message: "Mensagem enviada com sucesso.",
      sid: message.sid,
      status: message.status,
      to,
      from,
    });
  } catch (err) {
    return next(err);
  }
});

app.get("/api/twilio/status/:sid", async (req, res, next) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      return res.status(500).json({ error: "Twilio credentials missing" });
    }
    const client = twilio(accountSid, authToken);
    const message = await client.messages(req.params.sid).fetch();
    return res.status(200).json({
      ok: true,
      sid: message.sid,
      status: message.status,
      to: message.to,
      from: message.from,
      body: message.body,
      errorCode: message.errorCode ?? null,
      errorMessage: message.errorMessage ?? null,
      dateCreated: message.dateCreated,
      dateSent: message.dateSent,
      dateUpdated: message.dateUpdated,
    });
  } catch (err) {
    return next(err);
  }
});

// Public product routes
app.get("/api/products", (req, res, next) =>
  productController.list(req, res, next),
);
app.get("/api/products/top", (req, res, next) =>
  productController.listTopSelling(req, res, next),
);
app.get("/api/products/:productId", (req, res, next) =>
  productController.getById(req, res, next),
);

// Admin product management routes
app.get(
  "/api/admin/products",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.listAdmin(req, res, next),
);
app.post(
  "/api/admin/products",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.create(req, res, next),
);
app.put(
  "/api/admin/products/:productId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.update(req, res, next),
);
app.delete(
  "/api/admin/products/:productId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.deactivate(req, res, next),
);
app.patch(
  "/api/admin/products/:productId/restore",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.restore(req, res, next),
);
app.delete(
  "/api/admin/products/:productId/permanent",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => productController.delete(req, res, next),
);

app.post("/api/auth/register", authLimiter, (req, res, next) =>
  authController.register(req, res, next),
);

app.post("/api/auth/login", authLimiter, (req, res, next) =>
  authController.login(req, res, next),
);

app.post("/api/auth/totem/cpf", authLimiter, (req, res, next) =>
  authController.loginTotemByCpf(req, res, next),
);

app.post("/api/auth/totem/guest", authLimiter, (req, res, next) =>
  authController.createTotemGuest(req, res, next),
);

app.post(
  "/api/auth/users",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => authController.createUserByAdmin(req, res, next),
);

app.get(
  "/api/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE", "COZINHA"),
  (req, res, next) => orderController.listAll(req, res, next),
);

app.get(
  "/api/orders/pending-payments",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => orderController.pendingPayments(req, res, next),
);

// Motoboy: pedidos prontos para entrega
app.get(
  "/api/motoboy/orders",
  authenticateToken,
  authorizeRoles("MOTOBOY", "ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.motoboyOrders(req, res, next),
);

// Cálculo de frete (Nominatim + OSRM)
const deliveryService = new DeliveryService();
app.post(
  "/api/delivery/calculate",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { cep, numero, cidade, rua, complemento } =
        deliveryFreightSchema.parse(req.body);
      const result = await deliveryService.calculateFreight({
        cep,
        numero,
        cidade,
        rua,
        complemento,
      });
      return res.status(200).json({ data: result });
    } catch (err) {
      return next(err);
    }
  },
);

app.get(
  "/api/admin/orders/history",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.history(req, res, next),
);

app.get(
  "/api/admin/clients",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  async (_req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        where: { role: "CLIENTE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      return res.status(200).json({ data: users });
    } catch (err) {
      return next(err);
    }
  },
);

app.get(
  "/api/admin/analytics",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.analytics(req, res, next),
);

app.post(
  "/api/orders",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN"),
  (req, res, next) => orderController.create(req, res, next),
);

app.get(
  "/api/orders/me",
  authenticateToken,
  authorizeRoles("CLIENTE"),
  (req, res, next) => orderController.getMyOrders(req, res, next),
);

app.get(
  "/api/orders/:orderId",
  authenticateToken,
  authorizeRoles(
    "CLIENTE",
    "ADMIN",
    "COZINHA",
    "FUNCIONARIO",
    "ATENDENTE",
    "MOTOBOY",
    "MESA",
  ),
  enforceOrderOwnership,
  (req, res, next) => orderController.getById(req, res, next),
);

app.patch(
  "/api/orders/:orderId/cancel",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.cancel(req, res, next),
);

app.patch(
  "/api/orders/:orderId/assign-motoboy",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA"),
  (req, res, next) => orderController.assignMotoboy(req, res, next),
);

app.post(
  "/api/orders/:orderId/confirm-delivery",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE", "COZINHA", "MOTOBOY"),
  (req, res, next) => orderController.confirmDelivery(req, res, next),
);

app.patch(
  "/api/orders/:orderId/mark-paid",
  authenticateToken,
  authorizeRoles("MOTOBOY", "ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => orderController.markPaid(req, res, next),
);

app.get(
  "/api/admin/motoboys",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "COZINHA"),
  async (_req, res, next) => {
    try {
      const motoboys = await prisma.$queryRaw`
        SELECT id, name FROM "User" WHERE role::text = 'MOTOBOY' ORDER BY name ASC
      `;
      return res.status(200).json({ data: motoboys });
    } catch (err) {
      return next(err);
    }
  },
);

app.delete(
  "/api/orders/:orderId",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN"),
  (req, res, next) => orderController.deleteOrder(req, res, next),
);

app.patch(
  "/api/orders/:orderId/status",
  authenticateToken,
  authorizeRoles("ADMIN", "COZINHA", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => orderController.updateStatus(req, res, next),
);

app.patch(
  "/api/orders/:orderId/payment-status",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO"),
  (req, res, next) => orderController.adminUpdatePaymentStatus(req, res, next),
);

app.post("/api/payments/webhook", (req, res, next) =>
  orderController.paymentWebhook(req, res, next),
);

// MP IPN validation — sends GET to confirm the endpoint is alive
app.get("/api/payments/webhook", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// Confirmação explícita após retorno do Checkout Pro
// Garante que pedidos sejam marcados como APROVADO mesmo quando o webhook
// falha por external_reference nulo (bug conhecido do MP)
app.post(
  "/api/payments/checkout-confirm",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN", "MESA"),
  (req, res, next) => orderController.confirmCheckoutPayment(req, res, next),
);

app.post("/api/payments/preference", authenticateToken, (req, res, next) =>
  paymentController.createPreference(req, res, next),
);

app.get(
  "/api/admin/settings/totem-terminal",
  authenticateToken,
  authorizeRoles("ADMIN"),
  async (_req, res, next) => {
    try {
      const setting = await appSettingRepository.get("totem_terminal_id");
      return res.status(200).json({
        data: { terminalId: setting?.value ?? "" },
      });
    } catch (err) {
      return next(err);
    }
  },
);

app.put(
  "/api/admin/settings/totem-terminal",
  authenticateToken,
  authorizeRoles("ADMIN"),
  async (req, res, next) => {
    try {
      const terminalId = String(req.body?.terminalId ?? "").trim();
      await appSettingRepository.set("totem_terminal_id", terminalId);
      return res.status(200).json({
        message: "Maquininha do Totem atualizada.",
        data: { terminalId },
      });
    } catch (err) {
      return next(err);
    }
  },
);

app.post(
  "/api/totem/payments/terminal",
  authenticateToken,
  authorizeRoles("CLIENTE", "ADMIN"),
  (req, res, next) => paymentController.createTotemTerminalPayment(req, res, next),
);

// Mesa: acesso publico por token (QR code)
app.get("/api/mesas/acesso/:token", (req, res, next) =>
  mesaController.access(req, res, next),
);

// Mesa: CRUD (admin)
app.get(
  "/api/mesas",
  authenticateToken,
  authorizeRoles("ADMIN", "ATENDENTE"),
  (req, res, next) => mesaController.list(req, res, next),
);
app.get(
  "/api/mesas/open-totals",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => mesaController.openTotals(req, res, next),
);
app.post(
  "/api/mesas",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.create(req, res, next),
);
app.put(
  "/api/mesas/:mesaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.update(req, res, next),
);
app.delete(
  "/api/mesas/:mesaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.delete(req, res, next),
);
app.post(
  "/api/mesas/:mesaId/regenerar-token",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => mesaController.regenerateToken(req, res, next),
);

// Mesa: pedidos da sessao (role MESA)
app.get(
  "/api/mesa/orders",
  authenticateToken,
  authorizeRoles("MESA"),
  (req, res, next) => mesaController.myOrders(req, res, next),
);
app.get(
  "/api/mesas/:mesaId/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => mesaController.ordersByMesa(req, res, next),
);
app.post(
  "/api/mesa/orders",
  authenticateToken,
  authorizeRoles("MESA"),
  (req, res, next) => orderController.create(req, res, next),
);
app.post(
  "/api/mesas/:mesaId/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => orderController.create(req, res, next),
);

// Mesa: chamar garçom via socket
app.get(
  "/api/comandas",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => comandaController.list(req, res, next),
);
app.get(
  "/api/comandas/open-totals",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => comandaController.openTotals(req, res, next),
);
app.post(
  "/api/comandas",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => comandaController.create(req, res, next),
);
app.put(
  "/api/comandas/:comandaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => comandaController.update(req, res, next),
);
app.delete(
  "/api/comandas/:comandaId",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => comandaController.delete(req, res, next),
);
app.post(
  "/api/comandas/:comandaId/regenerar-token",
  authenticateToken,
  authorizeRoles("ADMIN"),
  (req, res, next) => comandaController.regenerateToken(req, res, next),
);
app.get(
  "/api/comandas/:comandaId/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => comandaController.ordersByComanda(req, res, next),
);
app.post(
  "/api/comandas/:comandaId/orders",
  authenticateToken,
  authorizeRoles("ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => orderController.create(req, res, next),
);
app.get(
  "/api/comandas/token/:token/summary",
  (req, res, next) => comandaController.summaryByToken(req, res, next),
);

const chamarGarcomLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 3,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: { error: { message: "Aguarde antes de chamar novamente." } },
});
app.post(
  "/api/mesas/chamar-garcom",
  authenticateToken,
  authorizeRoles("MESA"),
  chamarGarcomLimiter,
  (req, res) => {
    const { mesaNumber, mesaId } = req.body;
    emitChamarGarcom({
      mesaId: mesaId ?? req.user?.id,
      mesaNumber: mesaNumber ?? req.user?.mesaNumber,
      timestamp: new Date().toISOString(),
    });
    return res.status(200).json({ message: "Garçom chamado." });
  },
);

// Mesa: pagamento PIX (QR code no tablet)
app.post(
  "/api/mesa/payments/pix",
  authenticateToken,
  authorizeRoles("MESA", "ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) => paymentController.createMesaPixPayment(req, res, next),
);

// Mesa: pagamento na maquininha (MP Point)
app.post(
  "/api/mesa/payments/terminal",
  authenticateToken,
  authorizeRoles("MESA", "ADMIN", "FUNCIONARIO", "ATENDENTE"),
  (req, res, next) =>
    paymentController.createMesaTerminalPayment(req, res, next),
);

app.use(errorMiddleware);

export { app };
