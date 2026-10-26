// Teste da integração iFood sem tocar no banco: autentica, lista as lojas,
// busca os eventos e mostra como cada pedido entraria na cozinha do duBob.
//
// Uso (as credenciais ficam só no terminal, não vão para nenhum arquivo):
//   IFOOD_CLIENT_ID=... IFOOD_CLIENT_SECRET=... IFOOD_MERCHANT_ID=... node scripts/ifood-teste.js
//   ... node scripts/ifood-teste.js <id-do-pedido>     -> só esse pedido
//   ... node scripts/ifood-teste.js --confirmar         -> também confirma os pedidos novos
//
// Os eventos NÃO recebem ack aqui, então o duBob de verdade ainda vai recebê-los.
import { IfoodClient } from "../src/services/IfoodClient.js";
import {
  buildItemNotes,
  buildOrderNotes,
  getScheduledStart,
  mapIfoodPayment,
} from "../src/services/IfoodService.js";

const { IFOOD_CLIENT_ID, IFOOD_CLIENT_SECRET, IFOOD_MERCHANT_ID } = process.env;
const args = process.argv.slice(2);
const confirmar = args.includes("--confirmar");
const orderIdArg = args.find((a) => !a.startsWith("--"));

if (!IFOOD_CLIENT_ID || !IFOOD_CLIENT_SECRET) {
  console.error("Defina IFOOD_CLIENT_ID e IFOOD_CLIENT_SECRET no terminal.");
  process.exit(1);
}

const client = new IfoodClient(IFOOD_CLIENT_ID, IFOOD_CLIENT_SECRET);

async function mostrarPedido(orderId) {
  const order = await client.getOrder(orderId);
  const payment = mapIfoodPayment(order);
  console.log(`\n=== Pedido iFood #${order.displayId} (${orderId}) ===`);
  console.log("Tipo:", order.orderType, "| Entrega por:", order.delivery?.deliveredBy ?? "-");
  console.log("Agendado para:", getScheduledStart(order) ?? "não");
  console.log("Total:", order.total?.orderAmount, "| Pagamento:", payment.paymentStatus, payment.paymentMethod);
  console.log("Notas:", buildOrderNotes(order, payment.note));
  for (const item of order.items ?? []) {
    console.log(`  ${item.quantity}x ${buildItemNotes(item)} (PDV: ${item.externalCode ?? "-"})`);
  }
  try {
    const motivos = await client.cancellationReasons(orderId);
    console.log("Motivos de cancelamento:", motivos.map((m) => `${m.cancelCodeId} ${m.description}`).join(" / ") || "nenhum");
  } catch (error) {
    console.log("Motivos de cancelamento: erro -", error.message);
  }
  if (confirmar) {
    await client.confirm(orderId);
    console.log("Pedido confirmado no iFood.");
  }
}

try {
  const lojas = await client.testConnection();
  console.log(
    "Autenticou. Lojas:",
    lojas ? lojas.map((l) => `${l.name} (${l.id})`).join(", ") || "nenhuma" : "(sem módulo Merchant)",
  );

  if (orderIdArg) {
    await mostrarPedido(orderIdArg);
  } else {
    const events = await client.pollEvents(IFOOD_MERCHANT_ID);
    console.log(`\n${events.length} evento(s):`);
    for (const e of events) {
      console.log(`  ${e.code}/${e.fullCode} pedido ${e.orderId}`, e.metadata ? JSON.stringify(e.metadata) : "");
    }
    const novos = [...new Set(events.filter((e) => e.code === "PLC").map((e) => e.orderId))];
    for (const id of novos) await mostrarPedido(id);
  }
} catch (error) {
  console.error("Falhou:", error.message);
  process.exit(1);
}
process.exit(0);
