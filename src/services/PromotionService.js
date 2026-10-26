import { z } from "zod";
import { AppError } from "../errors/AppError.js";
import { PromotionRepository } from "../repositories/PromotionRepository.js";

const promotionSchema = z
  .object({
    title: z.string().trim().min(1, "Dê um nome para a promoção.").max(80),
    productId: z.string().min(1, "Escolha o produto."),
    size: z.enum(["PEQUENA", "MEDIA", "GRANDE", "FAMILIA"]).nullable().optional(),
    price: z.coerce.number().positive("O preço promocional deve ser maior que zero."),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    isActive: z.boolean().optional().default(true),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: "O fim da promoção deve ser depois do início.",
    path: ["endsAt"],
  });

const parse = (payload) => {
  const result = promotionSchema.safeParse(payload);
  if (!result.success) {
    throw new AppError(result.error.issues[0]?.message ?? "Promoção inválida.", 422);
  }
  return result.data;
};

export class PromotionService {
  constructor(repository = new PromotionRepository()) {
    this.repository = repository;
  }

  list() {
    return this.repository.list();
  }

  listActive() {
    return this.repository.listActive();
  }

  async create(payload) {
    return this.repository.create(parse(payload));
  }

  async update(id, payload) {
    const updated = await this.repository.update(id, parse(payload));
    if (!updated) throw new AppError("Promoção não encontrada.", 404);
    return updated;
  }

  async remove(id) {
    await this.repository.remove(id);
    return { removida: true };
  }
}
