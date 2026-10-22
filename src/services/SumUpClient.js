import { AppError } from "../errors/AppError.js";

const API = "https://api.sumup.com";

// Cliente da API da SumUp. Baseado na integração do CompactPay
// (backend/app/services/sumup.py).
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

  // Usuário gerenciado (sem convite por e-mail) para logar UMA maquininha.
  // As vendas feitas nela, inclusive Pix, voltam no histórico com esse
  // usuário no campo "user" — é assim que sabemos de qual maquininha veio.
  // A chave precisa do escopo members.write.
  async createManagedMember(merchantCode, { email, password, nickname }) {
    try {
      return await this.request("POST", `/v0.1/merchants/${merchantCode}/members`, {
        email,
        password,
        nickname: nickname.slice(0, 64),
        is_managed_user: true,
        roles: ["role_employee"],
        metadata: { origem: "dubob" },
      });
    } catch (error) {
      if ([401, 403].includes(error.providerStatus)) {
        throw new AppError(
          "A API key da SumUp não tem permissão para criar usuários (escopo members.write). Gere uma chave com essa permissão no painel da SumUp.",
          422,
        );
      }
      throw error;
    }
  }

  // Checkout online (delivery). Com hostedCheckout a SumUp devolve
  // hosted_checkout_url, uma página de cartão hospedada por ela.
  async createCheckout(merchantCode, { amount, reference, description, redirectUrl, hostedCheckout }) {
    return this.request("POST", "/v0.1/checkouts", {
      checkout_reference: reference,
      amount: Number(Number(amount).toFixed(2)),
      currency: "BRL",
      merchant_code: merchantCode,
      ...(description ? { description } : {}),
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
      ...(hostedCheckout ? { hosted_checkout: { enabled: true } } : {}),
    });
  }

  // Pix (APM): a resposta traz "artefacts" com o QR (barcode) e o copia-e-cola (code).
  async processPixCheckout(checkoutId, personalDetails) {
    return this.request("PUT", `/v0.1/checkouts/${checkoutId}`, {
      payment_type: "pix",
      ...(personalDetails ? { personal_details: personalDetails } : {}),
    });
  }

  // Fonte da verdade do status: PENDING, PAID, FAILED ou EXPIRED.
  async getCheckout(checkoutId) {
    return this.request("GET", `/v0.1/checkouts/${checkoutId}`);
  }

  // Lê um artefato do Pix: conteúdo inline ou baixado da URL indicada.
  async readArtefact(artefact) {
    if (!artefact) return null;
    if (artefact.content) return String(artefact.content);
    if (!artefact.location) return null;
    const response = await fetch(artefact.location, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return response.ok ? (await response.text()).trim() : null;
  }

  // Histórico de vendas aprovadas. Não filtramos por payment_types: no
  // CompactPay o filtro POS fazia a API devolver zero vendas da maquininha.
  async listSuccessfulTransactions(merchantCode, changesSince) {
    const query = new URLSearchParams({
      "statuses[]": "SUCCESSFUL",
      limit: "100",
      order: "ascending",
    });
    if (changesSince) query.set("changes_since", changesSince);
    const data = await this.request(
      "GET",
      `/v2.1/merchants/${merchantCode}/transactions/history?${query}`,
    );
    return (Array.isArray(data) ? data : data.items) ?? [];
  }
}
