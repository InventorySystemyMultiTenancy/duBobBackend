import { describe, expect, it, vi } from "vitest";

vi.mock("../src/realtime/socketServer.js", () => ({
  emitOrderCreated: vi.fn(),
  emitOrderStatusUpdated: vi.fn(),
  emitPaymentUpdated: vi.fn(),
}));

const { nextOrderNumber } = await import("../src/services/OrderService.js");

function fakeDb({ sequence }) {
  const fila = [...sequence];
  return {
    $queryRaw: vi.fn(async (strings) =>
      strings.join("?").includes("nextval") ? [{ n: fila.shift() }] : [],
    ),
  };
}

describe("número do pedido (1 a 1000)", () => {
  it("pega o próximo número da sequência", async () => {
    const db = fakeDb({ sequence: [7] });
    expect(await nextOrderNumber(db)).toBe(7);
  });

  it("pula número que ainda está num pedido em aberto", async () => {
    const emAberto = new Set([1, 2]);
    const fila = [1, 2, 3];
    const db = {
      $queryRaw: vi.fn(async (strings, ...valores) => {
        const sql = strings.join("?");
        if (sql.includes("nextval")) return [{ n: fila.shift() }];
        return emAberto.has(valores[0]) ? [{ "?column?": 1 }] : [];
      }),
    };
    expect(await nextOrderNumber(db)).toBe(3);
  });

  it("sem banco de verdade (testes antigos) não numera", async () => {
    expect(await nextOrderNumber({})).toBeNull();
  });
});
