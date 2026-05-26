import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import { ComandaService } from "../services/ComandaService.js";
import {
  createComandaSchema,
  updateComandaSchema,
} from "../validators/comandaSchemas.js";

const comandaService = new ComandaService();

export class ComandaController {
  async create(req, res, next) {
    try {
      const data = createComandaSchema.parse(req.body);
      const comanda = await comandaService.create(data);
      return res.status(201).json({ message: "Comanda criada.", data: comanda });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async list(_req, res, next) {
    try {
      const comandas = await comandaService.listAll();
      return res.status(200).json({ data: comandas });
    } catch (error) {
      return next(error);
    }
  }

  async openTotals(_req, res, next) {
    try {
      const totals = await comandaService.openTotals();
      return res.status(200).json({ data: totals });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async update(req, res, next) {
    try {
      const data = updateComandaSchema.parse(req.body);
      const comanda = await comandaService.update(req.params.comandaId, data);
      return res
        .status(200)
        .json({ message: "Comanda atualizada.", data: comanda });
    } catch (error) {
      return this.#handleError(error, next);
    }
  }

  async delete(req, res, next) {
    try {
      await comandaService.delete(req.params.comandaId);
      return res.status(200).json({ message: "Comanda removida." });
    } catch (error) {
      return next(error);
    }
  }

  async regenerateToken(req, res, next) {
    try {
      const comanda = await comandaService.regenerateToken(
        req.params.comandaId,
      );
      return res.status(200).json({ message: "Token regenerado.", data: comanda });
    } catch (error) {
      return next(error);
    }
  }

  async ordersByComanda(req, res, next) {
    try {
      const orders = await comandaService.getOrdersToday(req.params.comandaId);
      return res.status(200).json({ data: orders });
    } catch (error) {
      return next(error);
    }
  }

  async summaryByToken(req, res, next) {
    try {
      const summary = await comandaService.getSummaryByToken(req.params.token);
      return res.status(200).json({ data: summary });
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
