import { z } from "zod";

const sizeSchema = z.object({
  size: z.enum(["PEQUENA", "MEDIA", "GRANDE", "FAMILIA"]),
  label: z.string().trim().max(50).optional(),
  price: z.number().positive("Preco deve ser positivo"),
  costPrice: z.number().nonnegative("Custo deve ser positivo").optional(),
});

const availableDaySchema = z.enum([
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]);

export const createProductSchema = z.object({
  name: z.string().min(2, "Nome muito curto").max(100),
  description: z.string().max(300).optional(),
  imageUrl: z
    .string()
    .url("URL de imagem invalida")
    .optional()
    .or(z.literal("")),
  category: z.string().max(50).optional(),
  availableDays: z.array(availableDaySchema).optional(),
  waiterOnly: z.boolean().optional(),
  isCrust: z.boolean().optional(),
  sizes: z.array(sizeSchema).min(1, "Informe ao menos um tamanho com preco"),
});

export const updateProductSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(300).optional(),
  imageUrl: z
    .string()
    .url("URL de imagem invalida")
    .optional()
    .or(z.literal("")),
  category: z.string().max(50).optional(),
  availableDays: z.array(availableDaySchema).optional(),
  waiterOnly: z.boolean().optional(),
  isCrust: z.boolean().optional(),
  sizes: z.array(sizeSchema).min(1).optional(),
});
