import crypto from "crypto";
import { AppError } from "../errors/AppError.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { SumUpClient } from "./SumUpClient.js";
import { SumUpOperatorRepository } from "../repositories/SumUpOperatorRepository.js";
import { decryptSecret, encryptSecret } from "../lib/secretBox.js";

export const PAYMENT_PROVIDERS = {
  MERCADO_PAGO: "MERCADO_PAGO",
  SUMUP: "SUMUP",
};

// "payment_provider" é o nome antigo da chave da maquininha; mantido para
// não perder a escolha já salva.
const PROVIDER_KEYS = {
  terminal: "payment_provider",
  online: "online_payment_provider",
};
const SUMUP_API_KEY = "sumup_api_key";
const SUMUP_MERCHANT_KEY = "sumup_merchant_code";

const maskSecret = (value) =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "";

// Só letras e números, fácil de digitar na maquininha.
const generatePassword = (length = 14) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  while (true) {
    const password = Array.from(
      { length },
      () => alphabet[crypto.randomInt(alphabet.length)],
    ).join("");
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)) {
      return password;
    }
  }
};

export class PaymentSettingsService {
  constructor(
    appSettingRepository = new AppSettingRepository(),
    sumUpOperatorRepository = new SumUpOperatorRepository(),
  ) {
    this.appSettingRepository = appSettingRepository;
    this.sumUpOperatorRepository = sumUpOperatorRepository;
  }

  // channel "terminal": maquininha (totem, mesa e caixa).
  // channel "online": pagamento online (delivery).
  async getProvider(channel) {
    const setting = await this.appSettingRepository.get(PROVIDER_KEYS[channel]);
    return PAYMENT_PROVIDERS[setting?.value] ?? PAYMENT_PROVIDERS.MERCADO_PAGO;
  }

  // Credenciais salvas pelo admin têm prioridade; o .env fica de reserva.
  async getSumUpCredentials() {
    const [apiKeySetting, merchantSetting] = await Promise.all([
      this.appSettingRepository.get(SUMUP_API_KEY),
      this.appSettingRepository.get(SUMUP_MERCHANT_KEY),
    ]);
    const dbKey = apiKeySetting?.value?.trim();
    if (dbKey) {
      return {
        apiKey: dbKey,
        merchantCode: merchantSetting?.value?.trim() || "",
        source: "painel",
      };
    }
    const envKey = process.env.SUMUP_API_KEY?.trim();
    return {
      apiKey: envKey || "",
      merchantCode: process.env.SUMUP_MERCHANT_CODE?.trim() || "",
      source: envKey ? "env" : null,
    };
  }

  async requireSumUpClient() {
    const { apiKey, merchantCode } = await this.getSumUpCredentials();
    if (!apiKey) throw new AppError("SumUp não configurada.", 500);
    const client = new SumUpClient(apiKey);
    return {
      client,
      merchantCode: merchantCode || (await client.getMerchantCode()),
    };
  }

  async getAdminSettings() {
    const [terminalProvider, onlineProvider, sumup] = await Promise.all([
      this.getProvider("terminal"),
      this.getProvider("online"),
      this.getSumUpCredentials(),
    ]);
    return {
      terminalProvider,
      onlineProvider,
      mercadoPago: { configured: Boolean(process.env.MP_ACCESS_TOKEN) },
      sumup: {
        configured: Boolean(sumup.apiKey),
        apiKeyMasked: maskSecret(sumup.apiKey),
        merchantCode: sumup.merchantCode,
        source: sumup.source,
      },
    };
  }

  async updateAdminSettings({ terminalProvider, onlineProvider, sumupApiKey }) {
    if (sumupApiKey !== undefined) {
      const apiKey = String(sumupApiKey ?? "").trim();
      if (apiKey) {
        // Valida a chave e descobre o merchant_code sozinho (igual CompactPay).
        const merchantCode = await new SumUpClient(apiKey).getMerchantCode();
        await this.appSettingRepository.set(SUMUP_API_KEY, apiKey);
        await this.appSettingRepository.set(SUMUP_MERCHANT_KEY, merchantCode);
      } else {
        await this.appSettingRepository.set(SUMUP_API_KEY, "");
        await this.appSettingRepository.set(SUMUP_MERCHANT_KEY, "");
      }
    }

    if (terminalProvider !== undefined) {
      await this.#setProvider("terminal", terminalProvider);
    }
    if (onlineProvider !== undefined) {
      await this.#setProvider("online", onlineProvider);
    }

    return this.getAdminSettings();
  }

  async #setProvider(channel, provider) {
    if (!PAYMENT_PROVIDERS[provider]) {
      throw new AppError("Banco de pagamento inválido.", 422);
    }
    if (provider === PAYMENT_PROVIDERS.SUMUP) {
      const { apiKey } = await this.getSumUpCredentials();
      if (!apiKey) {
        throw new AppError("Cadastre a API key da SumUp antes de ativá-la.", 422);
      }
    }
    if (provider === PAYMENT_PROVIDERS.MERCADO_PAGO && !process.env.MP_ACCESS_TOKEN) {
      throw new AppError("Mercado Pago sem MP_ACCESS_TOKEN no servidor.", 422);
    }
    await this.appSettingRepository.set(PROVIDER_KEYS[channel], provider);
  }

  async listSumUpOperators() {
    return this.sumUpOperatorRepository.findAll();
  }

  // Cria a maquininha e o usuário dela na SumUp. A senha só é mostrada ao
  // admin para logar a maquininha (e pode ser vista de novo depois).
  async createSumUpOperator({ name }) {
    const label = String(name ?? "").trim();
    if (!label) throw new AppError("Informe o nome da maquininha.", 422);
    const { client, merchantCode } = await this.requireSumUpClient();

    const email = `maquininha.${crypto.randomBytes(3).toString("hex")}@dubob.com.br`;
    const password = generatePassword();
    const member = await client.createManagedMember(merchantCode, {
      email,
      password,
      nickname: `Dubob - ${label}`,
    });

    const operator = await this.sumUpOperatorRepository.create({
      name: label,
      email: String(member?.user?.email ?? email).toLowerCase(),
      passwordEnc: encryptSecret(password),
      memberId: member?.id ? String(member.id) : null,
    });
    return { ...operator, password };
  }

  async getSumUpOperatorLogin(id) {
    const operator = await this.sumUpOperatorRepository.findById(id);
    if (!operator) throw new AppError("Maquininha não encontrada.", 404);
    return {
      email: operator.email,
      password: decryptSecret(operator.passwordEnc),
    };
  }

  // Pareia o reader físico desta maquininha para o totem/caixa enviar a
  // cobrança direto para a tela dela.
  async pairSumUpOperatorReader(id, pairingCode) {
    const code = String(pairingCode ?? "").trim().toUpperCase();
    if (!code) throw new AppError("Informe o código que aparece na maquininha.", 422);
    const operator = await this.sumUpOperatorRepository.findById(id);
    if (!operator) throw new AppError("Maquininha não encontrada.", 404);

    const { client, merchantCode } = await this.requireSumUpClient();
    const reader = await client.createReader(merchantCode, code, operator.name);
    await this.sumUpOperatorRepository.setReaderId(id, reader.id);
    return { readerId: reader.id, status: reader.status };
  }

  async unpairSumUpOperatorReader(id) {
    await this.sumUpOperatorRepository.setReaderId(id, null);
  }

  // Só remove daqui; o usuário continua na conta SumUp (desative pelo painel dela).
  async deleteSumUpOperator(id) {
    await this.sumUpOperatorRepository.delete(id);
  }
}
