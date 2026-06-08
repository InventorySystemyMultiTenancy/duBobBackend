import { ExpenseService } from "../services/ExpenseService.js";
import {
  createExpenseSchema,
  listExpensesSchema,
} from "../validators/expenseSchemas.js";

const expenseService = new ExpenseService();

export class ExpenseController {
  async create(req, res, next) {
    try {
      const payload = createExpenseSchema.parse(req.body);
      const expense = await expenseService.createExpense({
        ...payload,
        userId: req.user?.id,
      });

      return res.status(201).json({
        message: "Gasto lancado com sucesso.",
        data: expense,
      });
    } catch (error) {
      return next(error);
    }
  }

  async list(req, res, next) {
    try {
      const filters = listExpensesSchema.parse(req.query);
      const result = await expenseService.listExpenses(filters);
      return res.status(200).json({ data: result });
    } catch (error) {
      return next(error);
    }
  }
}
