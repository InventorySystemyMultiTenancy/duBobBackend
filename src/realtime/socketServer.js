import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let ioInstance = null;

const STAFF_ROLES = new Set([
  "ADMIN",
  "FUNCIONARIO",
  "ATENDENTE",
  "COZINHA",
  "COZINHA_DELIVERY",
  "MOTOBOY",
]);

function getAllowedOrigins() {
  return (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim());
}

export function initializeSocketServer(server) {
  ioInstance = new Server(server, {
    cors: {
      origin: getAllowedOrigins(),
      methods: ["GET", "POST"],
    },
  });

  ioInstance.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Token não fornecido."));
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET);

      socket.data.user = {
        id: payload.sub,
        role: payload.role,
        email: payload.email,
      };

      return next();
    } catch {
      return next(new Error("Token inválido ou expirado."));
    }
  });

  ioInstance.on("connection", (socket) => {
    const { id, role } = socket.data.user;

    socket.join(`user:${id}`);
    socket.join(`role:${role}`);

    if (STAFF_ROLES.has(role)) {
      socket.join("staff");
    }
  });

  return ioInstance;
}

function emitToUserAndStaff(eventName, payload) {
  if (!ioInstance) {
    return;
  }

  ioInstance.to("staff").emit(eventName, payload);

  if (payload.userId) {
    ioInstance.to(`user:${payload.userId}`).emit(eventName, payload);
  }
}

export function emitOrderCreated(payload) {
  emitToUserAndStaff("order:created", payload);
}

// Outros interessados nas mudanças de pedido (ex.: avisos de WhatsApp).
// Todo status e pagamento passa por aqui, venha de onde vier.
const orderEventListeners = [];

export function onOrderEvent(listener) {
  orderEventListeners.push(listener);
}

function notifyOrderEvent(type, payload) {
  for (const listener of orderEventListeners) {
    Promise.resolve()
      .then(() => listener(type, payload))
      .catch((error) => console.error("[orderEvent]", error.message));
  }
}

export function emitOrderStatusUpdated(payload) {
  emitToUserAndStaff("order:status-updated", payload);
  notifyOrderEvent("status", payload);
}

export function emitPaymentUpdated(payload) {
  emitToUserAndStaff("order:payment-updated", payload);
  notifyOrderEvent("pagamento", payload);
}

export function emitChamarGarcom(payload) {
  if (!ioInstance) return;
  ioInstance.to("staff").emit("mesa:chamar-garcom", payload);
}

// Posição do motoboy: vai só para o cliente dono do pedido (não para "staff",
// senão todos os motoboys receberiam a localização uns dos outros).
export function emitMotoboyLocation(payload) {
  if (!ioInstance || !payload.userId) return;
  ioInstance.to(`user:${payload.userId}`).emit("order:motoboy-location", payload);
}
