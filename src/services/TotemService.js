import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError.js";
import { TotemRepository } from "../repositories/TotemRepository.js";

function isUniqueError(err) {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002") ||
    err?.meta?.code === "23505"
  );
}

export class TotemService {
  constructor(totemRepository = new TotemRepository()) {
    this.totemRepository = totemRepository;
  }

  buildSlug(number) {
    return `totem${number}`;
  }

  async create({ name, number, terminalId }) {
    try {
      return await this.totemRepository.create({
        name,
        number,
        slug: this.buildSlug(number),
        terminalId: terminalId ?? null,
      });
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("Numero de totem ja cadastrado.", 409);
      }
      throw err;
    }
  }

  async listAll() {
    return this.totemRepository.findAll();
  }

  async getPublicBySlug(slug) {
    const totem = await this.totemRepository.findBySlug(slug);
    if (!totem || !totem.isActive) {
      throw new AppError("Totem nao encontrado ou inativo.", 404);
    }
    return totem;
  }

  async findByPaymentRef({ totemId, totemSlug }) {
    const totem = totemId
      ? await this.totemRepository.findById(totemId)
      : await this.totemRepository.findBySlug(totemSlug);

    if (!totem || !totem.isActive) {
      throw new AppError("Totem nao encontrado ou inativo.", 404);
    }
    if (!totem.terminalId) {
      throw new AppError("Totem sem maquininha configurada.", 422);
    }
    return totem;
  }

  async update(id, data) {
    const totem = await this.totemRepository.findById(id);
    if (!totem) throw new AppError("Totem nao encontrado.", 404);
    const payload = { ...data };
    if (data.number) payload.slug = this.buildSlug(data.number);

    try {
      return await this.totemRepository.update(id, payload);
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("Numero de totem ja cadastrado.", 409);
      }
      throw err;
    }
  }

  async delete(id) {
    const totem = await this.totemRepository.findById(id);
    if (!totem) throw new AppError("Totem nao encontrado.", 404);
    return this.totemRepository.delete(id);
  }
}
