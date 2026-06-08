import { z } from "zod";

const amountSchema = z.coerce
  .number({ invalid_type_error: "Valor invalido." })
  .positive("Valor precisa ser maior que zero.")
  .max(999999.99, "Valor muito alto.");

const optionalDateSchema = z
  .string()
  .trim()
  .optional()
  .refine((value) => !value || !Number.isNaN(new Date(value).getTime()), {
    message: "Data invalida.",
  });

export const createExpenseSchema = z.object({
  name: z.string().trim().min(1, "Nome obrigatorio.").max(120),
  category: z.string().trim().min(1, "Categoria obrigatoria.").max(80),
  observation: z.string().trim().max(500).optional().or(z.literal("")),
  amount: amountSchema,
  spentAt: optionalDateSchema,
});

export const listExpensesSchema = z.object({
  from: optionalDateSchema,
  to: optionalDateSchema,
  category: z.string().trim().optional(),
});
