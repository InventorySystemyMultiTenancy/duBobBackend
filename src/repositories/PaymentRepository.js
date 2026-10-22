import { prisma } from "../lib/prisma.js";

export class PaymentRepository {
  async existsByExternalId(externalId) {
    const payment = await prisma.payment.findUnique({
      where: { externalId },
      select: { id: true },
    });
    return Boolean(payment);
  }

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
