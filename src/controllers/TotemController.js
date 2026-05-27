import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { TotemService } from "../services/TotemService.js";
import {
  createTotemSchema,
  updateTotemSchema,
} from "../validators/totemSchemas.js";

const totemService = new TotemService();

export class TotemController {
  async create(req, res, next) {
    try {
      const data = createTotemSchema.parse(req.body);
      const totem = await totemService.create(data);
      return res.status(201).json({ message: "Totem criado.", data: totem });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async list(_req, res, next) {
    try {
      const totens = await totemService.listAll();
      return res.status(200).json({ data: totens });
    } catch (error) {
      return next(error);
    }
  }

  async getPublic(req, res, next) {
    try {
      const totem = await totemService.getPublicBySlug(req.params.slug);
      return res.status(200).json({
        data: {
          id: totem.id,
          name: totem.name,
          number: totem.number,
          slug: totem.slug,
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async update(req, res, next) {
    try {
      const data = updateTotemSchema.parse(req.body);
      const totem = await totemService.update(req.params.totemId, data);
      return res.status(200).json({ message: "Totem atualizado.", data: totem });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async delete(req, res, next) {
    try {
      await totemService.delete(req.params.totemId);
      return res.status(200).json({ message: "Totem removido." });
    } catch (error) {
      return next(error);
    }
  }

  #handleError(error, next) {
    if (error instanceof ZodError) {
      return next(
        new AppError(error.errors[0]?.message ?? "Dados invalidos.", 422),
      );
    }
    return next(error);
  }
}
