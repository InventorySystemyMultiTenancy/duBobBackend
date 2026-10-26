import crypto from "crypto";
import { AppError } from "../errors/AppError.js";
import { AppSettingRepository } from "../repositories/AppSettingRepository.js";
import { WhatsappRepository } from "../repositories/WhatsappRepository.js";
import { decryptSecret, encryptSecret } from "../lib/secretBox.js";

// Avisos de WhatsApp do delivery pela Evolution API (mesma base do GrupoGK).
// Os avisos entram numa fila gravada no banco e saem um por vez, com pausa
// variada entre eles para não parecer disparo em massa. O pedido nunca
// depende do WhatsApp: se a Evolution cair, a fila só espera.

export const ETAPAS = {
  CONFIRMADO: "CONFIRMADO",
  SAIU: "SAIU",
  ENTREGUE: "ENTREGUE",
  CANCELADO: "CANCELADO",
};
// Começa só com "saiu para entrega" (aquecimento do número); o resto no admin
const ETAPAS_PADRAO = [ETAPAS.SAIU];
const INTERVALO_PADRAO = 15;
const INTERVALO_MINIMO = 8;
const MAX_TENTATIVAS = 3;
// Aviso que ficou preso na fila além disso não é mais enviado (chegaria atrasado)
const VALIDADE_MINUTOS = 60;
const PALAVRAS_SAIR = ["SAIR", "PARAR", "STOP", "CANCELAR", "DESCADASTRAR"];
const RODAPE =
  "\n\n_Mensagem automática do Dubob. Para não receber mais avisos, responda SAIR._";

const KEYS = {
  ativo: "whatsapp_ativo",
  url: "whatsapp_evolution_url",
  instancia: "whatsapp_instancia",
  apiKey: "whatsapp_api_key",
  intervalo: "whatsapp_intervalo_segundos",
  etapas: "whatsapp_etapas",
  webhookToken: "whatsapp_webhook_token",
};

// 55 + DDD + número; null se não der para usar
export function normalizarTelefone(telefone) {
  let digits = String(telefone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return /^55\d{10,11}$/.test(digits) ? digits : null;
}

const primeiroNome = (nome) => String(nome || "").trim().split(/\s+/)[0] || "";

// Campanhas: intervalo mínimo pedido pela loja; o padrão é bem maior
export const CAMPANHA_INTERVALO_MINIMO = 3;
export const CAMPANHA_INTERVALO_PADRAO = 20;

function validarIntervaloCampanha(valor) {
  const segundos = valor == null || valor === "" ? CAMPANHA_INTERVALO_PADRAO : Number(valor);
  if (!Number.isInteger(segundos) || segundos < CAMPANHA_INTERVALO_MINIMO || segundos > 600) {
    throw new AppError(
      `O intervalo deve ficar entre ${CAMPANHA_INTERVALO_MINIMO} e 600 segundos.`,
      422,
    );
  }
  return segundos;
}

const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Troca {nome} pelo primeiro nome; sem nome, tira o ", {nome}" junto
export function montarMensagemPromo(modelo, nome) {
  const primeiro = primeiroNome(nome);
  const texto = primeiro
    ? modelo.replace(/\{nome\}/gi, primeiro)
    : modelo.replace(/[,\s]*\{nome\}/gi, "");
  return texto.trim() + RODAPE;
}

export function montarMensagem(etapa, pedido) {
  const codigo = `#${String(pedido.id).slice(-6).toUpperCase()}`;
  const nome = primeiroNome(pedido.userName);
  const oi = nome ? `Oi, ${nome}!` : "Oi!";
  let texto;
  if (etapa === ETAPAS.CONFIRMADO) {
    texto = `${oi} 💜 Recebemos seu pedido ${codigo} no Dubob e ele já está sendo preparado.`;
  } else if (etapa === ETAPAS.SAIU) {
    texto =
      `${oi} 🛵 Seu pedido ${codigo} saiu para entrega` +
      (pedido.motoboyName ? ` com ${primeiroNome(pedido.motoboyName)}` : "") +
      "." +
      (pedido.deliveryCode
        ? `\n\nCódigo de entrega: *${pedido.deliveryCode}*\nInforme ao motoboy quando receber.`
        : "");
  } else if (etapa === ETAPAS.ENTREGUE) {
    texto = `Pedido ${codigo} entregue! Obrigado por pedir no Dubob 💜`;
  } else {
    texto = `${oi} Seu pedido ${codigo} foi cancelado. Se tiver alguma dúvida, fale com a gente.`;
  }
  return texto + RODAPE;
}

// Só pedidos de entrega (retirada, totem, balcão, mesa e comanda não recebem)
export function isDeliveryOrder(pedido) {
  return Boolean(pedido) && !pedido.isPickup && !pedido.mesaId && !pedido.comandaId;
}

// Qual aviso um evento de pedido gera (ou null)
export function etapaDoEvento(tipo, payload) {
  if (tipo === "status") {
    if (payload.status === "SAIU_PARA_ENTREGA") return ETAPAS.SAIU;
    if (payload.status === "ENTREGUE") return ETAPAS.ENTREGUE;
    if (payload.status === "CANCELADO") return ETAPAS.CANCELADO;
    return null;
  }
  if (tipo === "pagamento") {
    // Pago, ou liberado para a cozinha pelo caixa ("paga na entrega")
    if (payload.paymentStatus === "APROVADO") return ETAPAS.CONFIRMADO;
    if (payload.paymentMethod === "PAGAR_DEPOIS") return ETAPAS.CONFIRMADO;
  }
  return null;
}

export class WhatsappService {
  constructor(
    appSettingRepository = new AppSettingRepository(),
    whatsappRepository = new WhatsappRepository(),
    fetchImpl = (...args) => fetch(...args),
  ) {
    this.settings = appSettingRepository;
    this.repo = whatsappRepository;
    this.fetch = fetchImpl;
    this.processando = false;
    this.timer = null;
    this.pausa = null;
  }

  async #get(key) {
    return (await this.settings.get(key))?.value ?? null;
  }

  async lerConfig() {
    const [ativo, url, instancia, apiKeyEnc, intervalo, etapas] = await Promise.all([
      this.#get(KEYS.ativo),
      this.#get(KEYS.url),
      this.#get(KEYS.instancia),
      this.#get(KEYS.apiKey),
      this.#get(KEYS.intervalo),
      this.#get(KEYS.etapas),
    ]);
    let apiKey = null;
    if (apiKeyEnc) {
      try {
        apiKey = decryptSecret(apiKeyEnc);
      } catch {
        apiKey = null;
      }
    }
    let etapasLista = ETAPAS_PADRAO;
    try {
      if (etapas) etapasLista = JSON.parse(etapas);
    } catch {
      etapasLista = ETAPAS_PADRAO;
    }
    return {
      ativo: ativo === "true",
      evolutionUrl: url,
      instancia,
      apiKey,
      intervaloSegundos: Number(intervalo) || INTERVALO_PADRAO,
      etapas: etapasLista,
    };
  }

  // Para a tela do admin: a chave nunca volta inteira
  async getConfig() {
    const config = await this.lerConfig();
    return {
      ativo: config.ativo,
      evolutionUrl: config.evolutionUrl,
      instancia: config.instancia,
      apiKeyConfigurada: Boolean(config.apiKey),
      apiKeyMascarada: config.apiKey
        ? `${config.apiKey.slice(0, 4)}••••${config.apiKey.slice(-4)}`
        : null,
      intervaloSegundos: config.intervaloSegundos,
      etapas: config.etapas,
    };
  }

  async updateConfig(payload = {}) {
    const atual = await this.lerConfig();
    const novo = { ...atual };

    if (payload.evolutionUrl !== undefined) {
      const url = String(payload.evolutionUrl || "").trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) {
        throw new AppError("A URL da Evolution API deve começar com https://", 422);
      }
      novo.evolutionUrl = url || null;
    }
    if (payload.instancia !== undefined) {
      const instancia = String(payload.instancia || "").trim();
      if (instancia && !/^[\w.-]{1,60}$/.test(instancia)) {
        throw new AppError("Nome da instância: use letras, números, ponto, hífen ou _.", 422);
      }
      novo.instancia = instancia || null;
    }
    if (payload.apiKey !== undefined && String(payload.apiKey).trim()) {
      novo.apiKey = String(payload.apiKey).trim();
    }
    if (payload.intervaloSegundos !== undefined) {
      const segundos = Number(payload.intervaloSegundos);
      if (!Number.isInteger(segundos) || segundos < INTERVALO_MINIMO || segundos > 600) {
        throw new AppError(
          `O intervalo entre mensagens deve ficar entre ${INTERVALO_MINIMO} e 600 segundos.`,
          422,
        );
      }
      novo.intervaloSegundos = segundos;
    }
    if (payload.etapas !== undefined) {
      const validas = Object.values(ETAPAS);
      if (!Array.isArray(payload.etapas) || payload.etapas.some((e) => !validas.includes(e))) {
        throw new AppError("Etapas inválidas.", 422);
      }
      novo.etapas = [...new Set(payload.etapas)];
    }
    if (payload.ativo !== undefined) novo.ativo = Boolean(payload.ativo);

    if (novo.ativo && (!novo.evolutionUrl || !novo.apiKey || !novo.instancia)) {
      throw new AppError("Preencha URL, chave e instância da Evolution API antes de ativar.", 422);
    }

    await Promise.all([
      this.settings.set(KEYS.ativo, String(novo.ativo)),
      this.settings.set(KEYS.url, novo.evolutionUrl ?? ""),
      this.settings.set(KEYS.instancia, novo.instancia ?? ""),
      this.settings.set(KEYS.intervalo, String(novo.intervaloSegundos)),
      this.settings.set(KEYS.etapas, JSON.stringify(novo.etapas)),
      ...(novo.apiKey !== atual.apiKey
        ? [this.settings.set(KEYS.apiKey, encryptSecret(novo.apiKey))]
        : []),
    ]);

    this.agendar(1000);
    return this.getConfig();
  }

  async #evolution(config, caminho, { method = "GET", body } = {}) {
    if (!config?.evolutionUrl || !config?.apiKey) {
      throw new AppError("Configure a URL e a chave da Evolution API.", 422);
    }
    let resposta;
    try {
      resposta = await this.fetch(`${config.evolutionUrl}${caminho}`, {
        method,
        headers: { apikey: config.apiKey, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new AppError(`Não foi possível falar com a Evolution API: ${error.message}`, 502);
    }
    const texto = await resposta.text();
    let dados = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch {
      dados = { message: texto };
    }
    if (!resposta.ok) {
      const bruto =
        dados?.response?.message ?? dados?.message ?? dados?.error ?? resposta.statusText;
      const detalhe = Array.isArray(bruto)
        ? bruto.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ")
        : String(bruto);
      const erro = new AppError(
        resposta.status === 401 || resposta.status === 403
          ? "A Evolution API recusou a chave (apikey). Confira a configuração."
          : /"exists":\s*false/.test(detalhe)
            ? "Este número não tem WhatsApp."
            : `Evolution API respondeu ${resposta.status}: ${detalhe}`,
        resposta.status === 404 ? 404 : 502,
      );
      erro.httpStatus = resposta.status;
      erro.semWhatsapp = /"exists":\s*false/.test(detalhe);
      throw erro;
    }
    return dados;
  }

  async #estadoConexao(config) {
    const r = await this.#evolution(
      config,
      `/instance/connectionState/${encodeURIComponent(config.instancia)}`,
    );
    return r?.instance?.state || r?.state || "unknown";
  }

  async getConexao() {
    const config = await this.lerConfig();
    if (!config.evolutionUrl || !config.apiKey || !config.instancia) {
      return { configurado: false, estado: null };
    }
    try {
      return { configurado: true, estado: await this.#estadoConexao(config) };
    } catch (error) {
      if (error.httpStatus === 404) return { configurado: true, estado: "inexistente" };
      return { configurado: true, estado: "erro", erro: error.message };
    }
  }

  // QR Code para conectar o número; cria a instância se precisar e liga o
  // webhook que recebe as respostas (para o "SAIR")
  async conectar({ webhookBaseUrl } = {}) {
    const config = await this.lerConfig();
    if (!config.evolutionUrl || !config.apiKey || !config.instancia) {
      throw new AppError("Salve URL, chave e instância da Evolution API antes de conectar.", 422);
    }
    const estado = await this.#estadoConexao(config).catch((error) => {
      if (error.httpStatus === 404) return "inexistente";
      throw error;
    });

    await this.#configurarWebhook(config, webhookBaseUrl, estado === "inexistente");

    if (estado === "open") return { estado, qrBase64: null, pairingCode: null };

    let r;
    if (estado === "inexistente") {
      r = await this.#evolution(config, "/instance/create", {
        method: "POST",
        body: { instanceName: config.instancia, integration: "WHATSAPP-BAILEYS", qrcode: true },
      });
      r = r?.qrcode || r;
      await this.#configurarWebhook(config, webhookBaseUrl, false);
    } else {
      r = await this.#evolution(config, `/instance/connect/${encodeURIComponent(config.instancia)}`);
    }
    const base64 = r?.base64 || null;
    return {
      estado: "connecting",
      qrBase64: base64 && !base64.startsWith("data:") ? `data:image/png;base64,${base64}` : base64,
      pairingCode: r?.pairingCode || null,
    };
  }

  async #webhookToken() {
    let token = await this.#get(KEYS.webhookToken);
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      await this.settings.set(KEYS.webhookToken, token);
    }
    return token;
  }

  async #configurarWebhook(config, webhookBaseUrl, instanciaAindaNaoExiste) {
    if (!webhookBaseUrl || instanciaAindaNaoExiste) return;
    try {
      const token = await this.#webhookToken();
      await this.#evolution(config, `/webhook/set/${encodeURIComponent(config.instancia)}`, {
        method: "POST",
        body: {
          webhook: {
            enabled: true,
            url: `${webhookBaseUrl.replace(/\/+$/, "")}/api/whatsapp/webhook/${token}`,
            byEvents: false,
            base64: false,
            events: ["MESSAGES_UPSERT"],
          },
        },
      });
    } catch (error) {
      // Sem webhook só não funciona o "SAIR"; os avisos continuam
      console.error("[whatsapp] webhook:", error.message);
    }
  }

  async validarWebhookToken(token) {
    const salvo = await this.#get(KEYS.webhookToken);
    const recebido = String(token || "");
    if (!salvo || recebido.length !== salvo.length) return false;
    return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(salvo));
  }

  // Resposta do cliente: "SAIR" tira o número dos avisos
  async receberWebhook(body) {
    const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
    if (!data || data.key?.fromMe) return { ignorado: true };
    const texto = String(
      data.message?.conversation ?? data.message?.extendedTextMessage?.text ?? "",
    )
      .trim()
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (!PALAVRAS_SAIR.includes(texto)) return { ignorado: true };
    const telefone = normalizarTelefone(String(data.key?.remoteJid || "").split("@")[0]);
    if (!telefone) return { ignorado: true };
    await this.repo.optOut(telefone);
    const config = await this.lerConfig();
    this.#enviarTexto(config, telefone, "Pronto, você não vai mais receber avisos automáticos do Dubob. 💜")
      .catch((error) => console.error("[whatsapp] confirmação SAIR:", error.message));
    return { optOut: telefone };
  }

  async #enviarTexto(config, numero, texto) {
    return this.#evolution(
      config,
      `/message/sendText/${encodeURIComponent(config.instancia)}`,
      { method: "POST", body: { number: numero, text: texto, delay: 1200 } },
    );
  }

  async enviarTeste(telefone) {
    const numero = normalizarTelefone(telefone);
    if (!numero) throw new AppError("Celular inválido. Use DDD + número.", 422);
    const config = await this.lerConfig();
    await this.#enviarTexto(config, numero, "Teste do Dubob: os avisos de WhatsApp estão funcionando. 💜");
    return { enviado: true, numero };
  }

  // Evento de pedido (status ou pagamento): decide e coloca o aviso na fila.
  // Nunca lança erro: o WhatsApp não pode atrapalhar o pedido.
  async onOrderEvent(tipo, payload) {
    try {
      const etapa = etapaDoEvento(tipo, payload);
      if (!etapa || !payload?.orderId) return null;
      const config = await this.lerConfig();
      if (!config.ativo || !config.etapas.includes(etapa)) return null;

      const pedido = await this.repo.findOrderForNotice(payload.orderId);
      if (!isDeliveryOrder(pedido)) return null;
      const telefone = normalizarTelefone(pedido.contactPhone || pedido.userPhone);
      if (!telefone) return null;
      if (await this.repo.isOptedOut(telefone)) return null;

      const novo = await this.repo.enqueue({
        orderId: pedido.id,
        etapa,
        telefone,
        texto: montarMensagem(etapa, pedido),
      });
      if (novo) this.agendar(1000);
      return novo ? etapa : null;
    } catch (error) {
      console.error("[whatsapp] aviso do pedido:", error.message);
      return null;
    }
  }

  async getStatus() {
    const [config, conexao, fila] = await Promise.all([
      this.getConfig(),
      this.getConexao(),
      this.repo.queueSummary(),
    ]);
    return { config, conexao, fila: { ...fila, pausa: this.pausa } };
  }

  // Um envio por vez. Avisos de entrega têm prioridade sobre campanhas de
  // promoção. Se o número estiver desconectado, espera 1 minuto.
  async processarFila() {
    if (this.processando) return;
    this.processando = true;
    this.timer = null;
    let proximaEm = null;
    try {
      const config = await this.lerConfig();
      if (!config.evolutionUrl || !config.apiKey || !config.instancia) {
        this.pausa = null;
        return;
      }
      const aviso = config.ativo ? await this.repo.nextInQueue() : null;
      const promo = aviso ? null : await this.repo.nextCampaignMessage();
      if (!aviso && !promo) {
        this.pausa = null;
        await this.repo.closeFinishedCampaigns();
        return;
      }
      if (
        aviso &&
        Date.now() - new Date(aviso.createdAt).getTime() > VALIDADE_MINUTOS * 60 * 1000
      ) {
        await this.repo.markDiscarded(aviso.id, "Aviso antigo demais (não enviado atrasado).");
        proximaEm = 500;
        return;
      }

      let estado;
      try {
        estado = await this.#estadoConexao(config);
      } catch (error) {
        estado = error.message;
      }
      if (estado !== "open") {
        this.pausa =
          estado === "close" || estado === "connecting"
            ? "WhatsApp desconectado. Conecte o número na tela do WhatsApp."
            : `Evolution API indisponível: ${estado}`;
        proximaEm = 60 * 1000;
        return;
      }
      this.pausa = null;

      let intervalo;
      if (aviso) {
        if (!(await this.repo.reserve(aviso.id))) {
          proximaEm = 500;
          return;
        }
        try {
          await this.#enviarTexto(config, aviso.telefone, aviso.texto);
          await this.repo.markSent(aviso.id);
        } catch (error) {
          const tentativas = Number(aviso.tentativas) + 1;
          await this.repo.markFailed(aviso.id, error.message, {
            retry: !error.semWhatsapp && tentativas < MAX_TENTATIVAS,
          });
          console.error(`[whatsapp] pedido ${aviso.orderId}:`, error.message);
        }
        intervalo = Math.max(INTERVALO_MINIMO, config.intervaloSegundos);
      } else {
        if (!(await this.repo.reserveCampaignMessage(promo.id))) {
          proximaEm = 500;
          return;
        }
        try {
          await this.#enviarTexto(config, promo.telefone, promo.texto);
          await this.repo.finishCampaignMessage(promo.id);
        } catch (error) {
          await this.repo.finishCampaignMessage(promo.id, error.message);
          console.error(`[whatsapp] campanha ${promo.campaignId}:`, error.message);
        }
        await this.repo.closeFinishedCampaigns();
        intervalo = Math.max(CAMPANHA_INTERVALO_MINIMO, Number(promo.intervaloSegundos));
      }
      // Pausa variada (±30%) para não parecer disparo automático
      proximaEm = Math.round(intervalo * 1000 * (0.7 + Math.random() * 0.6));
    } catch (error) {
      console.error("[whatsapp] fila:", error.message);
      proximaEm = 60 * 1000;
    } finally {
      this.processando = false;
      if (proximaEm !== null) this.agendar(proximaEm);
    }
  }

  // ---- Promoções no WhatsApp (só para quem aceitou) ----

  setPromoOptIn(userId, aceita) {
    return this.repo.setPromoOptIn(userId, aceita);
  }

  getPromoOptIn(userId) {
    return this.repo.getPromoOptIn(userId);
  }

  // Quem vai receber: aceitou, tem celular válido e não respondeu SAIR.
  // Um envio por número (dois cadastros com o mesmo celular recebem uma vez).
  async #destinatariosPromo() {
    const [audiencia, sairam] = await Promise.all([
      this.repo.promoAudience(),
      this.repo.optOutList(),
    ]);
    const porTelefone = new Map();
    let semTelefone = 0;
    let saiu = 0;
    for (const pessoa of audiencia) {
      const telefone = normalizarTelefone(pessoa.telefone);
      if (!telefone) {
        semTelefone += 1;
      } else if (sairam.has(telefone)) {
        saiu += 1;
      } else if (!porTelefone.has(telefone)) {
        porTelefone.set(telefone, { telefone, nome: pessoa.name });
      }
    }
    return {
      aceitaram: audiencia.length,
      semTelefone,
      sairam: saiu,
      lista: [...porTelefone.values()],
    };
  }

  async previewCampanha({ intervaloSegundos } = {}) {
    const intervalo = validarIntervaloCampanha(intervaloSegundos);
    const { aceitaram, semTelefone, sairam, lista } = await this.#destinatariosPromo();
    return {
      aceitaram,
      semTelefone,
      sairam,
      destinatarios: lista.length,
      intervaloSegundos: intervalo,
      tempoEstimadoSegundos: lista.length * intervalo,
    };
  }

  async criarCampanha({ titulo, mensagens, intervaloSegundos } = {}, user = null) {
    const intervalo = validarIntervaloCampanha(intervaloSegundos);
    const textos = (Array.isArray(mensagens) ? mensagens : [])
      .map((m) => String(m ?? "").trim())
      .filter(Boolean);
    if (!textos.length) throw new AppError("Escreva pelo menos uma mensagem.", 422);
    if (textos.length > 5) throw new AppError("Use no máximo 5 versões da mensagem.", 422);
    if (textos.some((t) => t.length > 1000)) {
      throw new AppError("Cada mensagem pode ter no máximo 1000 caracteres.", 422);
    }
    const config = await this.lerConfig();
    if (!config.evolutionUrl || !config.apiKey || !config.instancia) {
      throw new AppError("Configure e conecte o WhatsApp antes de enviar promoções.", 422);
    }
    const { lista } = await this.#destinatariosPromo();
    if (!lista.length) throw new AppError("Ninguém aceitou receber promoções ainda.", 422);

    const id = await this.repo.createCampaign({
      titulo: String(titulo || "Promoção").trim().slice(0, 80) || "Promoção",
      mensagens: textos,
      intervaloSegundos: intervalo,
      criadoPor: user?.email ?? user?.id ?? null,
      destinatarios: lista.map((pessoa) => ({
        ...pessoa,
        texto: montarMensagemPromo(sortear(textos), pessoa.nome),
      })),
    });
    this.agendar(1000);
    return { id, destinatarios: lista.length };
  }

  listarCampanhas() {
    return this.repo.listCampaigns();
  }

  async cancelarCampanha(id) {
    await this.repo.cancelCampaign(id);
    return { cancelada: true };
  }

  agendar(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.processarFila().catch((error) => console.error("[whatsapp] fila:", error.message));
    }, ms);
    this.timer.unref?.();
  }

  async iniciar() {
    try {
      await this.repo.requeueSending();
    } catch (error) {
      console.error("[whatsapp] iniciar:", error.message);
      return;
    }
    this.agendar(15 * 1000);
  }
}

export const whatsappService = new WhatsappService();
