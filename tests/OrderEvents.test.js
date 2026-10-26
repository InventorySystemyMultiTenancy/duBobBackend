import { describe, expect, it, vi } from "vitest";
import {
  emitOrderStatusUpdated,
  emitPaymentUpdated,
  onOrderEvent,
} from "../src/realtime/socketServer.js";

describe("eventos de pedido para os avisos", () => {
  it("status e pagamento chegam aos ouvintes, e erro do ouvinte não quebra nada", async () => {
    const ouvinte = vi.fn();
    onOrderEvent(() => {
      throw new Error("ouvinte com defeito");
    });
    onOrderEvent(ouvinte);

    expect(() => emitOrderStatusUpdated({ orderId: "o1", status: "SAIU_PARA_ENTREGA" })).not.toThrow();
    emitPaymentUpdated({ orderId: "o1", paymentStatus: "APROVADO" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ouvinte).toHaveBeenCalledWith("status", { orderId: "o1", status: "SAIU_PARA_ENTREGA" });
    expect(ouvinte).toHaveBeenCalledWith("pagamento", { orderId: "o1", paymentStatus: "APROVADO" });
  });
});
