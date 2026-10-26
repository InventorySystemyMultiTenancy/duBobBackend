import axios from "axios";
import { AppError } from "../errors/AppError.js";

// Merchant API do iFood (app centralizado: client_credentials).
// O token vale ~6h; renovamos um pouco antes de vencer.
const BASE_URL = process.env.IFOOD_API_URL || "https://merchant-api.ifood.com.br";
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export class IfoodClient {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async #getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_MARGIN_MS) {
      return this.token;
    }
    try {
      const { data } = await axios.post(
        `${BASE_URL}/authentication/v1.0/oauth/token`,
        new URLSearchParams({
          grantType: "client_credentials",
          clientId: this.clientId,
          clientSecret: this.clientSecret,
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 15000,
        },
      );
      this.token = data.accessToken;
      this.tokenExpiresAt = Date.now() + Number(data.expiresIn || 3600) * 1000;
      return this.token;
    } catch (error) {
      const status = error.response?.status;
      throw new AppError(
        status === 401 || status === 400
          ? "iFood recusou o Client ID / Client Secret."
          : `Falha ao autenticar no iFood: ${error.message}`,
        502,
      );
    }
  }

  async #request(method, path, { data, headers } = {}) {
    const token = await this.#getToken();
    try {
      const response = await axios.request({
        method,
        url: `${BASE_URL}${path}`,
        data,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        timeout: 15000,
      });
      return response;
    } catch (error) {
      if (error.response?.status === 401) this.token = null;
      const detail = error.response?.data?.message || error.response?.data?.error?.message;
      const err = new Error(
        `iFood ${method} ${path} -> ${error.response?.status ?? error.code}${detail ? `: ${detail}` : ""}`,
      );
      err.status = error.response?.status ?? null;
      throw err;
    }
  }

  // Lista de lojas, ou null se o app ainda não tem o módulo Merchant
  // homologado (o login já foi validado pelo #getToken).
  async testConnection() {
    await this.#getToken();
    try {
      const { data } = await this.#request("GET", "/merchant/v1.0/merchants");
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.status === 401 || error.status === 403) return null;
      throw error;
    }
  }

  // 200 com lista de eventos, ou 204 sem nada novo.
  async pollEvents(merchantId) {
    const response = await this.#request("GET", "/events/v1.0/events:polling", {
      headers: merchantId ? { "x-polling-merchants": merchantId } : undefined,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async acknowledge(eventIds) {
    if (!eventIds.length) return;
    await this.#request("POST", "/events/v1.0/events/acknowledgment", {
      data: eventIds.map((id) => ({ id })),
    });
  }

  async getOrder(orderId) {
    const { data } = await this.#request("GET", `/order/v1.0/orders/${orderId}`);
    return data;
  }

  async #orderAction(orderId, action, data) {
    await this.#request("POST", `/order/v1.0/orders/${orderId}/${action}`, { data });
  }

  confirm(orderId) {
    return this.#orderAction(orderId, "confirm");
  }

  startPreparation(orderId) {
    return this.#orderAction(orderId, "startPreparation");
  }

  readyToPickup(orderId) {
    return this.#orderAction(orderId, "readyToPickup");
  }

  dispatch(orderId) {
    return this.#orderAction(orderId, "dispatch");
  }

  requestCancellation(orderId, { reason, cancellationCode }) {
    return this.#orderAction(orderId, "requestCancellation", { reason, cancellationCode });
  }

  // Motivos que o iFood aceita para cancelar esse pedido agora: [{cancelCodeId, description}]
  async cancellationReasons(orderId) {
    const { data } = await this.#request("GET", `/order/v1.0/orders/${orderId}/cancellationReasons`);
    return Array.isArray(data) ? data : [];
  }

  // Plataforma de negociação: o cliente pediu cancelamento e a loja responde
  acceptDispute(disputeId) {
    return this.#request("POST", `/order/v1.0/disputes/${disputeId}/accept`);
  }

  rejectDispute(disputeId, reason) {
    return this.#request("POST", `/order/v1.0/disputes/${disputeId}/reject`, {
      data: { reason },
    });
  }
}
