import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

function buildDateRange({ from, to } = {}) {
  const where = {};
  if (from || to) {
    where.spentAt = {};
    if (from) {
      const start = new Date(from);
      start.setHours(0, 0, 0, 0);
      where.spentAt.gte = start;
    }
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      where.spentAt.lte = end;
    }
  }
  return where;
}

function serializeExpense(expense) {
  return {
    ...expense,
    amount: Number(expense.amount),
  };
}

export class ExpenseService {
  async createExpense({ name, category, observation, amount, spentAt, userId }) {
    const expense = await prisma.expense.create({
      data: {
        name,
        category,
        observation: observation?.trim() || null,
        amount: new Prisma.Decimal(amount),
        spentAt: spentAt ? new Date(spentAt) : new Date(),
        createdBy: userId,
      },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    return serializeExpense(expense);
  }

  async listExpenses({ from, to, category } = {}) {
    const where = {
      ...buildDateRange({ from, to }),
      ...(category ? { category } : {}),
    };

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { spentAt: "desc" },
      include: {
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    const total = expenses.reduce(
      (sum, expense) => sum + Number(expense.amount),
      0,
    );

    const categoryTotals = new Map();
    for (const expense of expenses) {
      categoryTotals.set(
        expense.category,
        (categoryTotals.get(expense.category) ?? 0) + Number(expense.amount),
      );
    }

    return {
      expenses: expenses.map(serializeExpense),
      summary: {
        total: Number(total.toFixed(2)),
        count: expenses.length,
        categories: [...categoryTotals.entries()]
          .map(([name, amount]) => ({
            name,
            amount: Number(amount.toFixed(2)),
          }))
          .sort((a, b) => b.amount - a.amount),
      },
    };
  }

  async sumExpenses({ from, to } = {}) {
    const result = await prisma.expense.aggregate({
      where: buildDateRange({ from, to }),
      _sum: { amount: true },
    });

    return Number(result._sum.amount ?? 0);
  }
}
