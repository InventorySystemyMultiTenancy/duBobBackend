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
