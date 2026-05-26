import { z } from "zod";

export const createComandaSchema = z.object({
  name: z.string().min(1).max(100),
  number: z.number().int().positive(),
  isActive: z.boolean().optional(),
});

export const updateComandaSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  number: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});
