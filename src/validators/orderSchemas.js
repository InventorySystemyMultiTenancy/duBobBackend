import { z } from "zod";

const itemSchema = z
  .object({
    productId: z.string().min(1).max(255),
    size: z.enum(["PEQUENA", "MEDIA", "GRANDE", "FAMILIA"]).optional(),
    quantity: z.number().int().positive().max(20).optional(),
    addonIds: z
      .array(z.string().min(1).max(255))
      .max(20)
      .optional()
      .default([]),
    removedIngredients: z.string().trim().min(1).max(255).optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((item, ctx) => {
    if (!item.addonIds?.length) {
      return;
    }

    const uniqueCount = new Set(item.addonIds).size;
    if (uniqueCount !== item.addonIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "addonIds nao pode conter IDs repetidos.",
        path: ["addonIds"],
      });
    }
  });

export const createOrderSchema = z.object({
  deliveryAddress: z.string().min(1).max(255).optional(),
  isPickup: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  paymentMethod: z.string().min(2).max(50).optional(),
  deliveryFee: z.number().nonnegative().optional(),
  deliveryLat: z.number().optional(),
  deliveryLon: z.number().optional(),
  items: z.array(itemSchema).min(1).max(30),
});

export const deliveryFreightSchema = z.object({
  cep: z.string().regex(/^\d{5}-?\d{3}$/, "CEP inválido"),
  numero: z.string().min(1).max(20),
  cidade: z.string().min(2).max(100),
  rua: z.string().max(200).optional(),
  complemento: z.string().max(100).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    "RECEBIDO",
    "PREPARANDO",
    "PRONTO",
    "SAIU_PARA_ENTREGA",
    "ENTREGUE",
  ]),
});

export const paymentWebhookSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(), // e.g. "payment", "point_integration_wh"
    topic: z.string().optional(), // formato legado
    resource: z.union([z.string(), z.number()]).optional(), // formato legado
    action: z.string().optional(),
    status: z.string().optional(),
    external_reference: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    additional_info: z.record(z.any()).optional(),
    data: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        payment_id: z.union([z.string(), z.number()]).optional(),
        state: z.string().optional(),
        status: z.string().optional(),
        external_reference: z.string().optional(), // nova API /v1/orders
        status_detail: z.string().optional(),
        metadata: z.record(z.any()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
