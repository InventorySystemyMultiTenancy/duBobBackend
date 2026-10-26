import crypto from "crypto";
import { AppError } from "../errors/AppError.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { SumUpClient } from "./SumUpClient.js";
import { StoneClient } from "./StoneClient.js";
import { SumUpOperatorRepository } from "../repositories/SumUpOperatorRepository.js";
import { decryptSecret, encryptSecret } from "../lib/secretBox.js";

export const PAYMENT_PROVIDERS = {
  MERCADO_PAGO: "MERCADO_PAGO",
  SUMUP: "SUMUP",
  STONE: "STONE",
};

// Bancos aceitos em cada canal (a Stone por enquanto só na maquininha).
const CHANNEL_PROVIDERS = {
  terminal: ["MERCADO_PAGO", "SUMUP", "STONE"],
  online: ["MERCADO_PAGO", "SUMUP"],
};

const STONE_SECRET_KEY = "stone_secret_key";
const STONE_REFERER_KEY = "stone_service_referer_name";
const STONE_PAYMENT_TYPE_KEY = "stone_payment_type";
const STONE_PAYMENT_TYPES = ["", "debit", "credit", "voucher", "pix"];

// "payment_provider" é o nome antigo da chave da maquininha; mantido para
// não perder a escolha já salva.
const PROVIDER_KEYS = {
  terminal: "payment_provider",
  online: "online_payment_provider",
};
const SUMUP_API_KEY = "sumup_api_key";
const SUMUP_MERCHANT_KEY = "sumup_merchant_code";

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

  // Secret Key da Account Stone e o ServiceRefererName de parceiro: os do
  // painel têm prioridade; o .env fica de reserva.
  async getStoneCredentials() {
    const [keySetting, refererSetting, typeSetting] = await Promise.all([
      this.appSettingRepository.get(STONE_SECRET_KEY),
      this.appSettingRepository.get(STONE_REFERER_KEY),
      this.appSettingRepository.get(STONE_PAYMENT_TYPE_KEY),
    ]);
    const dbKey = keySetting?.value?.trim();
    const envKey = process.env.STONE_SECRET_KEY?.trim();
    return {
      secretKey: dbKey || envKey || "",
      source: dbKey ? "painel" : envKey ? "env" : null,
      serviceRefererName:
        refererSetting?.value?.trim() || process.env.STONE_SERVICE_REFERER_NAME?.trim() || "",
      paymentType: STONE_PAYMENT_TYPES.includes(typeSetting?.value) ? typeSetting.value : "",
    };
  }

  async requireStoneClient() {
    const { secretKey, serviceRefererName, paymentType } = await this.getStoneCredentials();
    if (!secretKey) throw new AppError("Stone não configurada.", 500);
    return {
      client: new StoneClient(secretKey, serviceRefererName),
      paymentType: paymentType || null,
    };
  }

  async getAdminSettings() {
    const [terminalProvider, onlineProvider, sumup, stone] = await Promise.all([
      this.getProvider("terminal"),
      this.getProvider("online"),
      this.getSumUpCredentials(),
      this.getStoneCredentials(),
    ]);
    return {
      terminalProvider,
      onlineProvider,
      stone: {
        // Nenhum pedaço da chave sai do servidor: só se está configurada
        configured: Boolean(stone.secretKey),
        source: stone.source,
        serviceRefererName: stone.serviceRefererName,
        paymentType: stone.paymentType,
      },
      mercadoPago: { configured: Boolean(process.env.MP_ACCESS_TOKEN) },
      sumup: {
        configured: Boolean(sumup.apiKey),
        merchantCode: sumup.merchantCode,
        source: sumup.source,
      },
    };
  }

  async updateAdminSettings({
    terminalProvider,
    onlineProvider,
    sumupApiKey,
    stoneSecretKey,
    stoneServiceRefererName,
    stonePaymentType,
  }) {
    if (stoneServiceRefererName !== undefined) {
      await this.appSettingRepository.set(
        STONE_REFERER_KEY,
        String(stoneServiceRefererName ?? "").trim(),
      );
    }
    if (stonePaymentType !== undefined) {
      if (!STONE_PAYMENT_TYPES.includes(stonePaymentType ?? "")) {
        throw new AppError("Forma de pagamento da Stone inválida.", 422);
      }
      await this.appSettingRepository.set(STONE_PAYMENT_TYPE_KEY, stonePaymentType ?? "");
    }
    if (stoneSecretKey !== undefined) {
      const secretKey = String(stoneSecretKey ?? "").trim();
      if (secretKey) {
        const { serviceRefererName } = await this.getStoneCredentials();
        await new StoneClient(secretKey, serviceRefererName).testKey();
      }
      await this.appSettingRepository.set(STONE_SECRET_KEY, secretKey);
    }

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
    if (!CHANNEL_PROVIDERS[channel].includes(provider)) {
      throw new AppError("Banco de pagamento inválido para este canal.", 422);
    }
    if (provider === PAYMENT_PROVIDERS.STONE) {
      const { secretKey } = await this.getStoneCredentials();
      if (!secretKey) {
        throw new AppError("Cadastre a Secret Key da Stone antes de ativá-la.", 422);
      }
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
  // Vincula pelo código de pareamento OU escolhendo um reader que já está
  // conectado à conta (quando o "Conectar" da maquininha liga direto).
  async pairSumUpOperatorReader(id, { pairingCode, readerId }) {
    const operator = await this.sumUpOperatorRepository.findById(id);
    if (!operator) throw new AppError("Maquininha não encontrada.", 404);
    const { client, merchantCode } = await this.requireSumUpClient();

    const existingId = String(readerId ?? "").trim();
    if (existingId) {
      const readers = await client.listReaders(merchantCode);
      const reader = readers.find((item) => item.id === existingId);
      if (!reader) throw new AppError("Maquininha não encontrada na conta SumUp.", 404);
      await this.sumUpOperatorRepository.setReaderId(id, reader.id);
      return { readerId: reader.id, status: reader.status };
    }

    const code = String(pairingCode ?? "").trim().toUpperCase();
    if (!code) throw new AppError("Informe o código ou escolha a maquininha.", 422);
    const reader = await client.createReader(merchantCode, code, operator.name);
    await this.sumUpOperatorRepository.setReaderId(id, reader.id);
    return { readerId: reader.id, status: reader.status };
  }

  async listSumUpReaders() {
    const { client, merchantCode } = await this.requireSumUpClient();
    return client.listReaders(merchantCode);
  }

  // Esquece o reader na conta SumUp e solta das maquininhas que o usavam.
  async forgetSumUpReader(readerId) {
    const { client, merchantCode } = await this.requireSumUpClient();
    await client.deleteReader(merchantCode, readerId);
    const operators = await this.sumUpOperatorRepository.findAll();
    for (const operator of operators.filter((item) => item.readerId === readerId)) {
      await this.sumUpOperatorRepository.setReaderId(operator.id, null);
    }
  }

  async unpairSumUpOperatorReader(id) {
    await this.sumUpOperatorRepository.setReaderId(id, null);
  }

  // Só remove daqui; o usuário continua na conta SumUp (desative pelo painel dela).
  async deleteSumUpOperator(id) {
    await this.sumUpOperatorRepository.delete(id);
  }
}
