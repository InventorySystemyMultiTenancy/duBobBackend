import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma.js";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAY_BY_SHORT_NAME = {
  Sun: "SUN",
  Mon: "MON",
  Tue: "TUE",
  Wed: "WED",
  Thu: "THU",
  Fri: "FRI",
  Sat: "SAT",
};

function getTodayCode() {
  const shortName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(new Date());
  return WEEKDAY_BY_SHORT_NAME[shortName] ?? "SUN";
}

function normalizeAvailableDays(days) {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.filter((day) => WEEKDAYS.includes(day)))];
}

function isAvailableToday(product) {
  const days = product.availableDays ?? [];
  return days.length === 0 || days.includes(getTodayCode());
}

function attachMetadata(product, metaMap) {
  const { stock, stockMinimum, ...rest } = product;
  const meta = metaMap.get(product.id);
  return {
    ...rest,
    category: meta?.category ?? "Geral",
    availableDays: meta?.availableDays ?? [],
    waiterOnly: meta?.waiterOnly ?? false,
  };
}

function attachSizeLabels(product, labelMap) {
  const labels = labelMap.get(product.id) ?? new Map();
  return {
    ...product,
    sizes: (product.sizes ?? []).map((size) => ({
      ...size,
      label: size.label ?? labels.get(size.id) ?? labels.get(size.size) ?? null,
    })),
  };
}

function isMissingSchemaFieldError(error) {
  return error?.code === "P2010" || error?.code === "P2022";
}

// Busca metadados via raw SQL (compatível com qualquer versão do Prisma Client)
async function fetchProductMetadata(ids) {
  if (!ids.length) return new Map();
  let rows;
  try {
    rows =
      await prisma.$queryRaw`SELECT "id", "category", "availableDays", "waiterOnly" FROM "Product" WHERE "id" = ANY(${ids})`;
  } catch (error) {
    if (!isMissingSchemaFieldError(error)) throw error;
    rows = await prisma.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ANY(${ids})`;
  }
  return new Map(
    rows.map((r) => [
      r.id,
      {
        category: r.category ?? "Geral",
        availableDays: normalizeAvailableDays(r.availableDays),
        waiterOnly: Boolean(r.waiterOnly),
      },
    ]),
  );
}

async function fetchSizeLabels(productIds) {
  if (!productIds.length) return new Map();
  try {
    const rows =
      await prisma.$queryRaw`SELECT "id", "productId", "size", "label" FROM "ProductSize" WHERE "productId" = ANY(${productIds})`;
    const labelMap = new Map();
    for (const row of rows) {
      if (!labelMap.has(row.productId)) labelMap.set(row.productId, new Map());
      const productLabels = labelMap.get(row.productId);
      productLabels.set(row.id, row.label ?? null);
      productLabels.set(row.size, row.label ?? null);
    }
    return labelMap;
  } catch {
    return new Map();
  }
}

async function fetchTableColumns(tx, tableName) {
  try {
    const rows = await tx.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    `;
    return new Set(rows.map((row) => row.column_name));
  } catch {
    return null;
  }
}

async function applySizeLabels(tx, productId, sizes = []) {
  const columns = await fetchTableColumns(tx, "ProductSize");
  if (columns && !columns.has("label")) return;

  for (const size of sizes) {
    if (size.label === undefined) continue;
    await tx.$executeRaw`
        UPDATE "ProductSize"
        SET "label" = ${size.label?.trim() || null}
        WHERE "productId" = ${productId}
          AND "size" = ${size.size}::"ProductSizeEnum"
      `;
  }
}

async function fetchProductColumns(tx) {
  return fetchTableColumns(tx, "Product");
}

async function updateProductMetadata(
  tx,
  productId,
  { category, availableDays, waiterOnly },
) {
  const columns = await fetchProductColumns(tx);

  if (category !== undefined && (!columns || columns.has("category"))) {
    await tx.$executeRaw`
        UPDATE "Product"
        SET "category" = ${category}
        WHERE "id" = ${productId}
      `;
  }

  if (
    availableDays !== undefined &&
    (!columns || columns.has("availableDays"))
  ) {
    await tx.$executeRaw`
        UPDATE "Product"
        SET "availableDays" = ${normalizeAvailableDays(availableDays)}
        WHERE "id" = ${productId}
      `;
  }

  if (waiterOnly !== undefined && (!columns || columns.has("waiterOnly"))) {
    await tx.$executeRaw`
        UPDATE "Product"
        SET "waiterOnly" = ${Boolean(waiterOnly)}
        WHERE "id" = ${productId}
      `;
  }
}

async function syncProductSizes(tx, productId, sizes = []) {
  console.log("[ProductRepository.syncProductSizes] inicio", {
    productId,
    sizes,
  });
  const productSizeColumns = await fetchTableColumns(tx, "ProductSize");
  const hasCostPrice = !productSizeColumns || productSizeColumns.has("costPrice");
  const submittedSizes = sizes.map(({ size }) => size);
  console.log("[ProductRepository.syncProductSizes] colunas", {
    productId,
    productSizeColumns: productSizeColumns ? [...productSizeColumns] : null,
    hasCostPrice,
    submittedSizes,
  });

  if (submittedSizes.length) {
    console.log("[ProductRepository.syncProductSizes] removendo tamanhos ausentes", {
      productId,
      submittedSizes,
    });
    await tx.$executeRaw`
      DELETE FROM "ProductSize"
      WHERE "productId" = ${productId}
        AND NOT ("size"::text = ANY(${submittedSizes}))
    `;
  } else {
    console.log("[ProductRepository.syncProductSizes] removendo todos tamanhos", {
      productId,
    });
    await tx.$executeRaw`
      DELETE FROM "ProductSize"
      WHERE "productId" = ${productId}
    `;
  }

  for (const { size, price, costPrice } of sizes) {
    console.log("[ProductRepository.syncProductSizes] upsert tamanho", {
      productId,
      size,
      price,
      costPrice,
      hasCostPrice,
    });
    if (hasCostPrice) {
      await tx.$executeRaw`
        INSERT INTO "ProductSize"
          ("id", "productId", "size", "price", "costPrice", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${productId}, ${size}::"ProductSizeEnum", ${price}, ${costPrice ?? null}, NOW(), NOW())
        ON CONFLICT ("productId", "size")
        DO UPDATE SET
          "price" = EXCLUDED."price",
          "costPrice" = EXCLUDED."costPrice",
          "updatedAt" = NOW()
      `;
    } else {
      await tx.$executeRaw`
        INSERT INTO "ProductSize"
          ("id", "productId", "size", "price", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${productId}, ${size}::"ProductSizeEnum", ${price}, NOW(), NOW())
        ON CONFLICT ("productId", "size")
        DO UPDATE SET
          "price" = EXCLUDED."price",
          "updatedAt" = NOW()
      `;
    }
  }
  console.log("[ProductRepository.syncProductSizes] fim", { productId });
}

export class ProductRepository {
  async findAll() {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: { sizes: { orderBy: { size: "asc" } } },
      orderBy: [{ isCrust: "asc" }, { name: "asc" }],
    });
    const productIds = products.map((p) => p.id);
    const metaMap = await fetchProductMetadata(productIds);
    const labelMap = await fetchSizeLabels(productIds);
    return products
      .map((p) => attachMetadata(attachSizeLabels(p, labelMap), metaMap))
      .filter((product) => isAvailableToday(product));
  }

  async findAllForAdmin() {
    const products = await prisma.product.findMany({
      include: { sizes: { orderBy: { size: "asc" } } },
      orderBy: [{ isCrust: "asc" }, { name: "asc" }],
    });
    const productIds = products.map((p) => p.id);
    const metaMap = await fetchProductMetadata(productIds);
    const labelMap = await fetchSizeLabels(productIds);
    return products.map((p) => attachMetadata(attachSizeLabels(p, labelMap), metaMap));
  }

  async create({
    name,
    description,
    imageUrl,
    category,
    availableDays,
    waiterOnly,
    isCrust,
    sizes,
  }) {
    // Campos adicionados depois do Prisma Client podem ser gravados via raw SQL.
    const product = await prisma.product.create({
      data: {
        name,
        description: description ?? null,
        imageUrl: imageUrl ?? null,
        isCrust: isCrust ?? false,
        sizes: {
          create: sizes.map(({ size, price, costPrice }) => ({
            size,
            price,
            ...(costPrice != null ? { costPrice } : {}),
          })),
        },
      },
      include: { sizes: { orderBy: { size: "asc" } } },
    });
    const cat = category ?? "Geral";
    const days = normalizeAvailableDays(availableDays);
    await updateProductMetadata(prisma, product.id, {
      category: cat,
      availableDays: days,
      waiterOnly: Boolean(waiterOnly),
    });
    await applySizeLabels(prisma, product.id, sizes);
    const labelMap = await fetchSizeLabels([product.id]);
    const { stock, stockMinimum, ...rest } = product;
    return {
      ...attachSizeLabels(rest, labelMap),
      category: cat,
      availableDays: days,
      waiterOnly: Boolean(waiterOnly),
    };
  }

  async update(
    productId,
    {
      name,
      description,
      imageUrl,
      category,
      availableDays,
      waiterOnly,
      isCrust,
      sizes,
    },
  ) {
    return prisma.$transaction(async (tx) => {
      console.log("[ProductRepository.update] inicio", {
        productId,
        hasSizes: Boolean(sizes),
        sizes,
      });
      let resolvedCategory = category;
      let resolvedAvailableDays = availableDays;
      let resolvedWaiterOnly = waiterOnly;

      await tx.product.update({
        where: { id: productId },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(imageUrl !== undefined && { imageUrl }),
          ...(isCrust !== undefined && { isCrust }),
        },
      });
      console.log("[ProductRepository.update] produto base atualizado", {
        productId,
      });

      resolvedCategory = category ?? "Geral";
      resolvedAvailableDays =
        availableDays !== undefined ? normalizeAvailableDays(availableDays) : [];
      resolvedWaiterOnly =
        waiterOnly !== undefined ? Boolean(waiterOnly) : false;
      await updateProductMetadata(tx, productId, {
        category,
        availableDays,
        waiterOnly,
      });
      console.log("[ProductRepository.update] metadados atualizados", {
        productId,
        category,
        availableDays,
        waiterOnly,
      });

      if (sizes) {
        await syncProductSizes(tx, productId, sizes);
        await applySizeLabels(tx, productId, sizes);
      }

      const updated = await tx.product.findUnique({
        where: { id: productId },
        include: { sizes: { orderBy: { size: "asc" } } },
      });
      console.log("[ProductRepository.update] produto recarregado", {
        productId,
        found: Boolean(updated),
        sizes: updated?.sizes,
      });
      const labelMap = await fetchSizeLabels([productId]);
      const { stock, stockMinimum, ...rest } = updated ?? {};
      return {
        ...attachSizeLabels(rest, labelMap),
        category: resolvedCategory ?? updated?.category ?? "Geral",
        availableDays:
          resolvedAvailableDays ?? updated?.availableDays ?? [],
        waiterOnly: resolvedWaiterOnly ?? updated?.waiterOnly ?? false,
      };
    });
  }

  async setActive(productId, isActive) {
    return prisma.product.update({
      where: { id: productId },
      data: { isActive },
    });
  }

  async deletePermanent(productId) {
    return prisma.$transaction(async (tx) => {
      const orderItemsCount = await tx.orderItem.count({
        where: { productId },
      });

      if (orderItemsCount > 0) {
        const error = new Error("PRODUCT_HAS_HISTORY");
        error.code = "PRODUCT_HAS_HISTORY";
        throw error;
      }

      await tx.productSize.deleteMany({ where: { productId } });
      return tx.product.delete({ where: { id: productId } });
    });
  }

  async findByIdWithSizes(productId) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { sizes: true },
    });
    if (!product) return null;
    const metaMap = await fetchProductMetadata([productId]);
    const labelMap = await fetchSizeLabels([productId]);
    return attachMetadata(attachSizeLabels(product, labelMap), metaMap);
  }

  async findTopSelling(limit = 6) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT oi."productId", SUM(oi.quantity)::int AS "soldCount"
       FROM "OrderItem" oi
       INNER JOIN "Order" o ON o.id = oi."orderId"
       INNER JOIN "Product" p ON p.id = oi."productId"
       WHERE oi."productId" IS NOT NULL
         AND o."paymentStatus"::text = 'APROVADO'
         AND p."isActive" = true
         AND p."isCrust" = false
       GROUP BY oi."productId"
       ORDER BY "soldCount" DESC, oi."productId" ASC
       LIMIT $1`,
      limit,
    );

    if (!rows.length) {
      return [];
    }

    const ids = rows.map((row) => row.productId);
    const soldCountById = new Map(
      rows.map((row) => [row.productId, row.soldCount]),
    );
    const products = await prisma.product.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        isCrust: false,
      },
      include: {
        sizes: { orderBy: { size: "asc" } },
      },
    });

    const productIds = products.map((product) => product.id);
    const metaMap = await fetchProductMetadata(productIds);
    const labelMap = await fetchSizeLabels(productIds);
    const productsById = new Map(
      products.map((product) => [product.id, product]),
    );

    return ids
      .map((id) => productsById.get(id))
      .filter(Boolean)
      .map((product) => ({
        ...attachMetadata(attachSizeLabels(product, labelMap), metaMap),
        soldCount: soldCountById.get(product.id) ?? 0,
      }))
      .filter((product) => isAvailableToday(product));
  }

  async findSizePrice(productId, size, { isCrust } = {}) {
    const sizeEntry = await prisma.productSize.findUnique({
      where: {
        productId_size: {
          productId,
          size,
        },
      },
      include: {
        product: {
          select: {
            id: true,
            isActive: true,
            isCrust: true,
          },
        },
      },
    });

    if (!sizeEntry?.product?.isActive) {
      return null;
    }

    if (typeof isCrust === "boolean" && sizeEntry.product.isCrust !== isCrust) {
      return null;
    }

    return sizeEntry;
  }
}
