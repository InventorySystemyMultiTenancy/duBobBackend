import { prisma } from "../lib/prisma.js";

export class PaymentRepository {
  async upsertFromWebhook({
    orderId,
    provider = "MERCADO_PAGO",
    externalId,
    status,
    payload,
    amount,
  }) {
    return prisma.payment.upsert({
      where: { orderId },
      update: {
        provider,
        externalId,
        status,
        payload,
        ...(amount ? { amount } : {}),
      },
      create: {
        orderId,
        provider,
        externalId,
        status,
        amount,
        payload,
      },
    });
  }
}
