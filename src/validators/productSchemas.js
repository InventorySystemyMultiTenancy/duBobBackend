import { z } from "zod";

const sizeSchema = z.object({
  size: z.enum(["PEQUENA", "MEDIA", "GRANDE", "FAMILIA"]),
  label: z.string().trim().max(50).optional(),
  price: z.number().nonnegative("Preco deve ser positivo"),
  costPrice: z.number().nonnegative("Custo deve ser positivo").optional(),
});

const normalizeCategory = (category) =>
  String(category ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const isConfigCategory = (category) => {
  const normalized = normalizeCategory(category);
  return (
    normalized.includes("sabor ") ||
    normalized.includes("complemento") ||
    normalized.includes("adicionais")
  );
};

const validatePricesByCategory = (data, ctx) => {
  if (isConfigCategory(data.category)) return;

  data.sizes?.forEach((size, index) => {
    if (size.price <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Preco deve ser positivo",
        path: ["sizes", index, "price"],
      });
    }
  });
};

const availableDaySchema = z.enum([
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]);

export const createProductSchema = z
  .object({
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
  })
  .superRefine(validatePricesByCategory);

export const updateProductSchema = z
  .object({
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
  })
  .superRefine(validatePricesByCategory);
