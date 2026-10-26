import { describe, expect, it } from "vitest";
import {
  buildBenefitsNote,
  buildItemNotes,
  buildOrderNotes,
  getScheduledStart,
  isMerchantDelivery,
  mapIfoodPayment,
} from "../src/services/IfoodService.js";

const ifoodOrder = {
  id: "abc-123",
  displayId: "4821",
  orderType: "DELIVERY",
  customer: { name: "Maria Souza", phone: { number: "0800 123 4567", localizer: "12345678" } },
  delivery: { deliveredBy: "IFOOD", observations: "Portão azul" },
};

describe("IfoodService", () => {
  it("pedido pago online entra como aprovado", () => {
    const result = mapIfoodPayment({
      payments: { prepaid: 42.5, pending: 0, methods: [{ method: "CREDIT", type: "ONLINE" }] },
    });
    expect(result).toMatchObject({ paymentStatus: "APROVADO", paymentMethod: "IFOOD_ONLINE" });
  });

  it("pagamento na entrega fica pendente com troco nas notas", () => {
    const result = mapIfoodPayment({
      payments: {
        prepaid: 0,
        pending: 30,
        methods: [{ method: "CASH", type: "OFFLINE", cash: { changeFor: 50 } }],
      },
    });
    expect(result.paymentStatus).toBe("PENDENTE");
    expect(result.paymentMethod).toBe("IFOOD_CASH");
    expect(result.note).toBe("Cobrar na entrega R$ 30,00: Dinheiro (troco p/ R$ 50,00)");
  });

  it("item leva nome do iFood, complementos e observação", () => {
    const notes = buildItemNotes({
      name: "Açaí 500ml | grande",
      observations: "sem banana",
      options: [
        { name: "Granola", quantity: 1 },
        { name: "Leite Ninho", quantity: 2 },
      ],
    });
    expect(notes).toBe(
      "iFood: Açaí 500ml / grande | Complementos: Granola, 2x Leite Ninho | Obs: sem banana",
    );
  });

  it("notas do pedido trazem número, cliente e tipo de entrega", () => {
    const notes = buildOrderNotes(ifoodOrder, "Pago no iFood");
    expect(notes.startsWith("Pedido iFood #4821 | Cliente: Maria Souza | Entrega iFood")).toBe(true);
    expect(notes).toContain("Obs entrega: Portão azul");
  });

  it("só a entrega feita pela loja precisa de motoboy", () => {
    expect(isMerchantDelivery(ifoodOrder)).toBe(false);
    expect(
      isMerchantDelivery({ ...ifoodOrder, delivery: { deliveredBy: "MERCHANT" } }),
    ).toBe(true);
    expect(isMerchantDelivery({ orderType: "TAKEOUT" })).toBe(false);
  });

  it("cartão na entrega mostra a bandeira", () => {
    const result = mapIfoodPayment({
      payments: {
        pending: 20,
        methods: [{ method: "CREDIT", type: "OFFLINE", card: { brand: "Visa" } }],
      },
    });
    expect(result.note).toBe("Cobrar na entrega R$ 20,00: Crédito Visa");
  });

  it("desconto mostra quanto o iFood e a loja pagam", () => {
    const note = buildBenefitsNote({
      benefits: [
        {
          value: 10,
          sponsorshipValues: [
            { name: "IFOOD", value: 6 },
            { name: "MERCHANT", value: 4 },
          ],
        },
      ],
    });
    expect(note).toBe("Desconto: R$ 10,00 (iFood R$ 6,00, loja R$ 4,00)");
    expect(buildBenefitsNote({})).toBeNull();
  });

  it("pedido agendado traz o horário escolhido nas notas", () => {
    const scheduled = {
      ...ifoodOrder,
      orderTiming: "SCHEDULED",
      schedule: {
        deliveryDateTimeStart: "2026-10-27T17:00:00Z",
        deliveryDateTimeEnd: "2026-10-27T17:30:00Z",
      },
    };
    expect(getScheduledStart(scheduled)).toBe("2026-10-27T17:00:00Z");
    expect(getScheduledStart(ifoodOrder)).toBeNull();
    expect(buildOrderNotes(scheduled, "Pago no iFood")).toContain(
      "AGENDADO p/ 27/10, 14:00 às 14:30",
    );
  });

  it("notas trazem CPF na nota e ponto de referência", () => {
    const notes = buildOrderNotes(
      {
        ...ifoodOrder,
        customer: { ...ifoodOrder.customer, documentNumber: "12345678900" },
        delivery: { ...ifoodOrder.delivery, deliveryAddress: { reference: "Perto da padaria" } },
      },
      "Pago no iFood",
    );
    expect(notes).toContain("CPF na nota: 12345678900");
    expect(notes).toContain("Ref: Perto da padaria");
  });
});
