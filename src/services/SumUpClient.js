import { AppError } from "../errors/AppError.js";

const API = "https://api.sumup.com";

// Cliente da API da SumUp (Cloud API das maquininhas Solo).
// Baseado na integração do CompactPay (backend/app/services/sumup.py).
export class SumUpClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async request(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    if (!response.ok) {
      console.error(`[SumUp] ${method} ${path} falhou (${response.status}):`, raw);
      const detail =
        data.message || data.error_message || data.detail || data.raw || "erro sem detalhe";
      const error = new AppError(
        `SumUp retornou erro ${response.status}: ${detail}`,
        response.status === 401 ? 422 : 502,
      );
      error.providerStatus = response.status;
      throw error;
    }

    return data;
  }

  // Resolve o merchant_code só a partir da API key.
  async getMerchantCode() {
    const data = await this.request("GET", "/v0.1/me");
    const merchantCode = data?.merchant_profile?.merchant_code;
    if (!merchantCode) {
      throw new AppError("SumUp não retornou merchant_code para esta API key.", 502);
    }
    return String(merchantCode);
  }

  async listReaders(merchantCode) {
    const data = await this.request("GET", `/v0.1/merchants/${merchantCode}/readers`);
    const items = Array.isArray(data) ? data : (data.items ?? data.readers ?? data.data ?? []);
    return items.map((item) => ({
      id: item.id ?? item.reader_id,
      name: item.name ?? item.device?.identifier ?? null,
      status: item.status ?? null,
      deviceIdentifier: item.device?.identifier ?? null,
      model: item.device?.model ?? null,
    }));
  }

  // O pairing_code é gerado NO APARELHO: menu > Conexões > Wi-Fi > API >
  // Conectar. Expira em 5 minutos.
  async createReader(merchantCode, pairingCode, name) {
    const data = await this.request("POST", `/v0.1/merchants/${merchantCode}/readers`, {
      pairing_code: pairingCode,
      ...(name ? { name } : {}),
    });
    if (!data.id) throw new AppError("SumUp não retornou o id da maquininha.", 502);
    return {
      id: data.id,
      name: data.name ?? data.device?.identifier ?? null,
      status: data.status ?? null,
      deviceIdentifier: data.device?.identifier ?? null,
    };
  }

  async getReaderStatus(merchantCode, readerId) {
    try {
      const data = await this.request(
        "GET",
        `/v0.1/merchants/${merchantCode}/readers/${readerId}/status`,
      );
      const status = String((data.data ?? data).status ?? "").toLowerCase();
      return {
        status: status || "unknown",
        online: ["online", "idle", "ready"].includes(status),
      };
    } catch {
      return { status: "unavailable", online: false };
    }
  }

  async createReaderCheckout(merchantCode, readerId, { amount, description, returnUrl }) {
    const data = await this.request(
      "POST",
      `/v0.1/merchants/${merchantCode}/readers/${readerId}/checkout`,
      {
        total_amount: {
          currency: "BRL",
          minor_unit: 2,
          value: Math.round(Number(amount) * 100),
        },
        ...(description ? { description } : {}),
        ...(returnUrl ? { return_url: returnUrl } : {}),
      },
    );
    const payload = data.data ?? data;
    const clientTransactionId = payload.client_transaction_id ?? payload.checkout_id ?? payload.id;
    if (!clientTransactionId) {
      throw new AppError("SumUp não retornou o id da cobrança.", 502);
    }
    return { clientTransactionId: String(clientTransactionId) };
  }

  // Cancela a cobrança que está aberta na tela da maquininha.
  async terminateReaderCheckout(merchantCode, readerId) {
    await this.request(
      "POST",
      `/v0.1/merchants/${merchantCode}/readers/${readerId}/terminate`,
    );
  }

  // Fonte da verdade do status: nunca confiamos só no corpo do webhook.
  async getTransactionByClientId(merchantCode, clientTransactionId) {
    const query = new URLSearchParams({ client_transaction_id: clientTransactionId });
    try {
      return await this.request(
        "GET",
        `/v2.1/merchants/${merchantCode}/transactions?${query}`,
      );
    } catch (error) {
      // 404 = cliente ainda não passou o cartão/Pix.
      if (error.providerStatus === 404) return null;
      throw error;
    }
  }
}
