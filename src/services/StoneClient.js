import { AppError } from "../errors/AppError.js";

// Stone Connect 2.0: a API é a da Pagar.me (grupo Stone). Um pedido aberto
// com o serial da maquininha aparece direto na tela dela.
// Doc: https://connect-stone.stone.com.br/llms.txt
const API = "https://api.pagar.me/core/v5";

export class StoneClient {
  constructor(secretKey, serviceRefererName) {
    this.secretKey = secretKey;
    this.serviceRefererName = serviceRefererName;
  }

  async request(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        // Identificador de parceiro dado pela Stone no Partner Hub.
        ...(this.serviceRefererName
          ? { ServiceRefererName: this.serviceRefererName }
          : {}),
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
      console.error(`[Stone] ${method} ${path} falhou (${response.status}):`, raw);
      const detail = data.message || data.raw || "erro sem detalhe";
      const error = new AppError(
        response.status === 401
          ? "A Stone recusou a Secret Key (401). Confira a chave em Admin → Pagamentos."
          : `Stone retornou erro ${response.status}: ${detail}`,
        response.status === 401 ? 422 : 502,
      );
      error.providerStatus = response.status;
      throw error;
    }

    return data;
  }

  // Só para validar a chave ao salvar.
  async testKey() {
    await this.request("GET", "/orders?page=1&size=1");
  }

  // Pedido direto para a maquininha. Com paymentType ("debit", "credit",
  // "voucher" ou "pix") ela já abre a tela de pagamento; sem ele o pedido fica
  // na lista da maquininha e o cliente escolhe a forma de pagamento.
  async createTerminalOrder({ amountCents, code, description, displayName, serialNumber, paymentType }) {
    return this.request("POST", "/orders", {
      code,
      items: [{ amount: amountCents, description, quantity: 1, code }],
      customer: { name: "Cliente Dubob" },
      closed: false,
      poi_payment_settings: {
        visible: true,
        display_name: displayName,
        print_order_receipt: false,
        devices_serial_number: [serialNumber],
        ...(paymentType
          ? {
              payment_setup: {
                type: paymentType,
                installments: 1,
                installment_type: "merchant",
              },
            }
          : {}),
      },
    });
  }

  // A doc recomenda usar só como garantia (tem limite de consultas).
  async getOrder(orderId) {
    return this.request("GET", `/orders/${orderId}`);
  }

  // status "paid" depois de confirmar o pagamento (obrigatório, senão a
  // maquininha para de mostrar pedidos novos) ou "canceled" para tirar da tela.
  async closeOrder(orderId, status) {
    return this.request("PATCH", `/orders/${orderId}/closed`, { status });
  }
}
