import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ||= "segredo-de-teste";

const { WhatsappService, normalizarTelefone, etapaDoEvento, montarMensagem } =
  await import("../src/services/WhatsappService.js");
const { encryptSecret } = await import("../src/lib/secretBox.js");

function fakeSettings(values = {}) {
  const store = {
    whatsapp_ativo: "true",
    whatsapp_evolution_url: "https://evo.exemplo.com",
    whatsapp_instancia: "dubob",
    whatsapp_api_key: encryptSecret("chave-123"),
    whatsapp_intervalo_segundos: "15",
    whatsapp_etapas: JSON.stringify(["CONFIRMADO", "SAIU", "ENTREGUE", "CANCELADO"]),
    ...values,
  };
  return {
    get: vi.fn(async (key) => (store[key] != null ? { key, value: store[key] } : null)),
    set: vi.fn(async (key, value) => {
      store[key] = value;
      return { key, value };
    }),
  };
}

const pedidoDelivery = {
  id: "cmpedido000AB12CD",
  isPickup: false,
  mesaId: null,
  comandaId: null,
  deliveryCode: "4821",
  contactPhone: "(11) 98765-4321",
  userPhone: null,
  userName: "Maria Souza",
  motoboyName: "João Lima",
};

function fakeRepo(pedido = pedidoDelivery) {
  return {
    findOrderForNotice: vi.fn(async () => pedido),
    isOptedOut: vi.fn(async () => false),
    enqueue: vi.fn(async () => true),
    nextInQueue: vi.fn(async () => null),
    reserve: vi.fn(async () => true),
    markSent: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    markDiscarded: vi.fn(async () => {}),
    optOut: vi.fn(async () => {}),
    nextCampaignMessage: vi.fn(async () => null),
    reserveCampaignMessage: vi.fn(async () => true),
    finishCampaignMessage: vi.fn(async () => {}),
    closeFinishedCampaigns: vi.fn(async () => {}),
    promoAudience: vi.fn(async () => []),
    optOutList: vi.fn(async () => new Set()),
    createCampaign: vi.fn(async () => "camp-1"),
  };
}

const jsonResponse = (status, body) => ({
  ok: status < 400,
  status,
  statusText: String(status),
  text: async () => JSON.stringify(body),
});

describe("WhatsApp do delivery: regras", () => {
  it("normaliza o celular para 55 + DDD + número", () => {
    expect(normalizarTelefone("(11) 98765-4321")).toBe("5511987654321");
    expect(normalizarTelefone("5511987654321")).toBe("5511987654321");
    expect(normalizarTelefone("1234")).toBeNull();
    expect(normalizarTelefone(null)).toBeNull();
  });

  it("transforma status e pagamento no aviso certo", () => {
    expect(etapaDoEvento("status", { status: "SAIU_PARA_ENTREGA" })).toBe("SAIU");
    expect(etapaDoEvento("status", { status: "ENTREGUE" })).toBe("ENTREGUE");
    expect(etapaDoEvento("status", { status: "CANCELADO" })).toBe("CANCELADO");
    expect(etapaDoEvento("status", { status: "PREPARANDO" })).toBeNull();
    expect(etapaDoEvento("pagamento", { paymentStatus: "APROVADO" })).toBe("CONFIRMADO");
    expect(etapaDoEvento("pagamento", { paymentStatus: "PENDENTE", paymentMethod: "PAGAR_DEPOIS" })).toBe("CONFIRMADO");
    expect(etapaDoEvento("pagamento", { paymentStatus: "RECUSADO" })).toBeNull();
  });

  it("'saiu para entrega' leva motoboy e código de entrega, sem endereço", () => {
    const texto = montarMensagem("SAIU", pedidoDelivery);
    expect(texto).toContain("Oi, Maria!");
    expect(texto).toContain("#AB12CD");
    expect(texto).toContain("com João");
    expect(texto).toContain("*4821*");
    expect(texto).toContain("responda SAIR");
  });
});

describe("WhatsApp do delivery: quando entra na fila", () => {
  let repo;
  beforeEach(() => {
    repo = fakeRepo();
  });

  it("pedido de entrega com celular entra na fila", async () => {
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    const etapa = await service.onOrderEvent("status", { orderId: "x", status: "SAIU_PARA_ENTREGA" });
    expect(etapa).toBe("SAIU");
    expect(repo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ etapa: "SAIU", telefone: "5511987654321" }),
    );
    clearTimeout(service.timer);
  });

  it("retirada, totem e balcão não recebem aviso", async () => {
    repo = fakeRepo({ ...pedidoDelivery, isPickup: true });
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    expect(await service.onOrderEvent("status", { orderId: "x", status: "SAIU_PARA_ENTREGA" })).toBeNull();
    expect(repo.enqueue).not.toHaveBeenCalled();
  });

  it("não envia com o WhatsApp desligado, etapa desligada ou para quem pediu SAIR", async () => {
    const desligado = new WhatsappService(fakeSettings({ whatsapp_ativo: "false" }), repo, vi.fn());
    expect(await desligado.onOrderEvent("status", { orderId: "x", status: "ENTREGUE" })).toBeNull();

    const soSaiu = new WhatsappService(
      fakeSettings({ whatsapp_etapas: JSON.stringify(["SAIU"]) }),
      repo,
      vi.fn(),
    );
    expect(await soSaiu.onOrderEvent("status", { orderId: "x", status: "ENTREGUE" })).toBeNull();

    repo.isOptedOut.mockResolvedValue(true);
    const optOut = new WhatsappService(fakeSettings(), repo, vi.fn());
    expect(await optOut.onOrderEvent("status", { orderId: "x", status: "SAIU_PARA_ENTREGA" })).toBeNull();
    expect(repo.enqueue).not.toHaveBeenCalled();
  });

  it("erro no WhatsApp nunca quebra a mudança do pedido", async () => {
    repo.findOrderForNotice.mockRejectedValue(new Error("banco fora"));
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    await expect(
      service.onOrderEvent("status", { orderId: "x", status: "SAIU_PARA_ENTREGA" }),
    ).resolves.toBeNull();
  });
});

describe("WhatsApp do delivery: fila", () => {
  const mensagem = (extra = {}) => ({
    id: "m1",
    orderId: "o1",
    telefone: "5511987654321",
    texto: "oi",
    tentativas: 0,
    createdAt: new Date(),
    ...extra,
  });

  it("envia quando o número está conectado", async () => {
    const repo = fakeRepo();
    repo.nextInQueue.mockResolvedValue(mensagem());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }))
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: "abc" } }));
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://evo.exemplo.com/message/sendText/dubob");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ number: "5511987654321" });
    expect(repo.markSent).toHaveBeenCalledWith("m1");
  });

  it("desconectado: não gasta a mensagem e espera", async () => {
    const repo = fakeRepo();
    repo.nextInQueue.mockResolvedValue(mensagem());
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { instance: { state: "close" } }));
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(repo.reserve).not.toHaveBeenCalled();
    expect(service.pausa).toMatch(/desconectado/);
  });

  it("número sem WhatsApp vira erro sem nova tentativa", async () => {
    const repo = fakeRepo();
    repo.nextInQueue.mockResolvedValue(mensagem());
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }))
      .mockResolvedValueOnce(jsonResponse(400, { response: { message: [{ exists: false }] } }));
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(repo.markFailed).toHaveBeenCalledWith("m1", expect.any(String), { retry: false });
  });

  it("aviso antigo é descartado em vez de chegar atrasado", async () => {
    const repo = fakeRepo();
    repo.nextInQueue.mockResolvedValue(mensagem({ createdAt: new Date(Date.now() - 2 * 3600 * 1000) }));
    const fetchImpl = vi.fn();
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(repo.markDiscarded).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("WhatsApp do delivery: SAIR", () => {
  it("cliente que responde SAIR deixa de receber", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {}));
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    const r = await service.receberWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "5511987654321@s.whatsapp.net", fromMe: false },
        message: { conversation: " sair " },
      },
    });
    expect(r).toEqual({ optOut: "5511987654321" });
    expect(repo.optOut).toHaveBeenCalledWith("5511987654321");
  });

  it("outras mensagens são ignoradas", async () => {
    const repo = fakeRepo();
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    const r = await service.receberWebhook({
      data: { key: { remoteJid: "5511987654321@s.whatsapp.net" }, message: { conversation: "cadê meu pedido?" } },
    });
    expect(r).toEqual({ ignorado: true });
    expect(repo.optOut).not.toHaveBeenCalled();
  });
});

const { montarMensagemPromo } = await import("../src/services/WhatsappService.js");

describe("Promoções no WhatsApp", () => {
  const audiencia = [
    { id: "u1", name: "Maria Souza", telefone: "(11) 98765-4321" },
    { id: "u2", name: "Maria Outra Conta", telefone: "11987654321" }, // mesmo número
    { id: "u3", name: "Pedro", telefone: null },
    { id: "u4", name: "Ana", telefone: "21999998888" }, // respondeu SAIR
    { id: "u5", name: "", telefone: "31988887777" },
  ];

  it("troca {nome} pelo primeiro nome e sempre põe o SAIR", () => {
    expect(montarMensagemPromo("Oi {nome}, milk shake em dobro!", "Maria Souza")).toMatch(
      /^Oi Maria, milk shake em dobro!/,
    );
    expect(montarMensagemPromo("Oi, {nome}! Promo hoje", "")).toMatch(/^Oi! Promo hoje/);
    expect(montarMensagemPromo("Promo", "Ana")).toContain("responda SAIR");
  });

  it("prévia conta só quem pode receber e calcula o tempo", async () => {
    const repo = fakeRepo();
    repo.promoAudience.mockResolvedValue(audiencia);
    repo.optOutList.mockResolvedValue(new Set(["5521999998888"]));
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    const preview = await service.previewCampanha({ intervaloSegundos: 20 });
    expect(preview).toMatchObject({
      aceitaram: 5,
      semTelefone: 1,
      sairam: 1,
      destinatarios: 2,
      intervaloSegundos: 20,
      tempoEstimadoSegundos: 40,
    });
  });

  it("intervalo mínimo de 3 segundos", async () => {
    const service = new WhatsappService(fakeSettings(), fakeRepo(), vi.fn());
    await expect(service.previewCampanha({ intervaloSegundos: 2 })).rejects.toThrow(/entre 3 e 600/);
    await expect(service.previewCampanha({ intervaloSegundos: 3 })).resolves.toMatchObject({
      intervaloSegundos: 3,
    });
  });

  it("cria a campanha com uma das versões da mensagem para cada pessoa", async () => {
    const repo = fakeRepo();
    repo.promoAudience.mockResolvedValue(audiencia);
    const service = new WhatsappService(fakeSettings(), repo, vi.fn());
    const r = await service.criarCampanha({
      titulo: "Dobro de sábado",
      mensagens: ["Oi {nome}, versão A", "{nome}, versão B", ""],
      intervaloSegundos: 10,
    });
    clearTimeout(service.timer);
    expect(r).toEqual({ id: "camp-1", destinatarios: 3 });
    const { destinatarios, mensagens, intervaloSegundos } = repo.createCampaign.mock.calls[0][0];
    expect(mensagens).toEqual(["Oi {nome}, versão A", "{nome}, versão B"]);
    expect(intervaloSegundos).toBe(10);
    expect(destinatarios[0].texto).toMatch(/Maria/);
    expect(destinatarios.every((d) => /versão (A|B)/.test(d.texto))).toBe(true);
  });

  it("avisos de entrega saem antes da campanha", async () => {
    const repo = fakeRepo();
    repo.nextInQueue.mockResolvedValue({ id: "m1", orderId: "o1", telefone: "5511987654321", texto: "saiu", tentativas: 0, createdAt: new Date() });
    repo.nextCampaignMessage.mockResolvedValue({ id: "c1", campaignId: "camp-1", telefone: "5511911112222", texto: "promo", intervaloSegundos: 3 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }))
      .mockResolvedValueOnce(jsonResponse(201, {}));
    const service = new WhatsappService(fakeSettings(), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(repo.markSent).toHaveBeenCalledWith("m1");
    expect(repo.reserveCampaignMessage).not.toHaveBeenCalled();
  });

  it("campanha sai mesmo com os avisos de entrega desligados", async () => {
    const repo = fakeRepo();
    repo.nextCampaignMessage.mockResolvedValue({ id: "c1", campaignId: "camp-1", telefone: "5511911112222", texto: "promo", intervaloSegundos: 3 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { instance: { state: "open" } }))
      .mockResolvedValueOnce(jsonResponse(201, {}));
    const service = new WhatsappService(fakeSettings({ whatsapp_ativo: "false" }), repo, fetchImpl);
    await service.processarFila();
    clearTimeout(service.timer);
    expect(repo.nextInQueue).not.toHaveBeenCalled();
    expect(repo.finishCampaignMessage).toHaveBeenCalledWith("c1");
    expect(repo.closeFinishedCampaigns).toHaveBeenCalled();
  });
});

const { preencherTexto, TEXTOS_PADRAO } = await import("../src/services/WhatsappService.js");

describe("Textos editáveis dos avisos", () => {
  it("troca as variáveis e tira o trecho quando falta o dado", () => {
    const modelo = "Oi, {nome}! Pedido {pedido} saiu com {motoboy}.\nCódigo: {codigo}";
    expect(preencherTexto(modelo, { nome: "Maria", pedido: "#AB12CD", motoboy: "João", codigo: "4821" })).toBe(
      "Oi, Maria! Pedido #AB12CD saiu com João.\nCódigo: 4821",
    );
    expect(preencherTexto(modelo, { nome: "", pedido: "#AB12CD", motoboy: "", codigo: "" })).toBe(
      "Oi! Pedido #AB12CD saiu.",
    );
  });

  it("o aviso usa o texto editado pelo admin", async () => {
    const repo = fakeRepo();
    const settings = fakeSettings({
      whatsapp_textos: JSON.stringify({ SAIU: "{nome}, tá chegando! Código {codigo}" }),
    });
    const service = new WhatsappService(settings, repo, vi.fn());
    await service.onOrderEvent("status", { orderId: "x", status: "SAIU_PARA_ENTREGA" });
    clearTimeout(service.timer);
    const { texto } = repo.enqueue.mock.calls[0][0];
    expect(texto).toMatch(/^Maria, tá chegando! Código 4821/);
    expect(texto).toContain("responda SAIR");
  });

  it("salva os textos; vazio volta ao padrão e texto gigante é recusado", async () => {
    const settings = fakeSettings();
    const service = new WhatsappService(settings, fakeRepo(), vi.fn());
    const config = await service.updateConfig({
      textos: { CONFIRMADO: "Recebemos, {nome}!", ENTREGUE: "   " },
    });
    clearTimeout(service.timer);
    expect(config.textos.CONFIRMADO).toBe("Recebemos, {nome}!");
    expect(config.textos.ENTREGUE).toBe(TEXTOS_PADRAO.ENTREGUE);
    await expect(service.updateConfig({ textos: { SAIU: "x".repeat(1001) } })).rejects.toThrow(/1000/);
    clearTimeout(service.timer);
  });
});

describe("Número do pedido nos avisos", () => {
  it("usa o número de 1 a 1000 quando o pedido tem", () => {
    expect(montarMensagem("ENTREGUE", { ...pedidoDelivery, number: 42 })).toMatch(/^Pedido #42 entregue!/);
    expect(montarMensagem("ENTREGUE", pedidoDelivery)).toMatch(/^Pedido #AB12CD entregue!/);
  });
});
