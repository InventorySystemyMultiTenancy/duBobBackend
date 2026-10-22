import { AppError } from "../errors/AppError.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { SumUpClient } from "./SumUpClient.js";

export const PAYMENT_PROVIDERS = {
  MERCADO_PAGO: "MERCADO_PAGO",
  SUMUP: "SUMUP",
};

const PROVIDER_KEY = "payment_provider";
const SUMUP_API_KEY = "sumup_api_key";
const SUMUP_MERCHANT_KEY = "sumup_merchant_code";

const maskSecret = (value) =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "";

export class PaymentSettingsService {
  constructor(appSettingRepository = new AppSettingRepository()) {
    this.appSettingRepository = appSettingRepository;
  }

  // Banco usado nas cobranças da maquininha (mesa e totem).
  async getActiveProvider() {
    const setting = await this.appSettingRepository.get(PROVIDER_KEY);
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
    const [provider, sumup] = await Promise.all([
      this.getActiveProvider(),
      this.getSumUpCredentials(),
    ]);
    return {
      provider,
      mercadoPago: { configured: Boolean(process.env.MP_ACCESS_TOKEN) },
      sumup: {
        configured: Boolean(sumup.apiKey),
        apiKeyMasked: maskSecret(sumup.apiKey),
        merchantCode: sumup.merchantCode,
        source: sumup.source,
      },
    };
  }

  async updateAdminSettings({ provider, sumupApiKey }) {
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

    if (provider !== undefined) {
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
      await this.appSettingRepository.set(PROVIDER_KEY, provider);
    }

    return this.getAdminSettings();
  }

  async listSumUpReaders() {
    const { client, merchantCode } = await this.requireSumUpClient();
    const readers = await client.listReaders(merchantCode);
    return Promise.all(
      readers.map(async (reader) => ({
        ...reader,
        connection: await client.getReaderStatus(merchantCode, reader.id),
      })),
    );
  }

  async pairSumUpReader({ pairingCode, name }) {
    const code = String(pairingCode ?? "").trim();
    if (!code) throw new AppError("Informe o código de pareamento.", 422);
    const { client, merchantCode } = await this.requireSumUpClient();
    return client.createReader(merchantCode, code, String(name ?? "").trim());
  }
}
