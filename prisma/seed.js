import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const defaultUsers = [
  {
    name: "Administrador",
    email: process.env.SEED_ADMIN_EMAIL || "admin@dubob.com",
    password: process.env.SEED_ADMIN_PASSWORD || "Admin123!",
    role: "ADMIN",
  },
  {
    name: "Funcionario",
    email: process.env.SEED_FUNCIONARIO_EMAIL || "funcionario@dubob.com",
    password: process.env.SEED_FUNCIONARIO_PASSWORD || "Func123!",
    role: "FUNCIONARIO",
  },
  {
    name: "Cozinha",
    email: process.env.SEED_COZINHA_EMAIL || "cozinha@dubob.com",
    password: process.env.SEED_COZINHA_PASSWORD || "Coz123!",
    role: "COZINHA",
  },
  {
    name: "Cliente",
    email: process.env.SEED_CLIENTE_EMAIL || "cliente@dubob.com",
    password: process.env.SEED_CLIENTE_PASSWORD || "Cli123!",
    role: "CLIENTE",
  },
];

async function run() {
  for (const user of defaultUsers) {
    const passwordHash = await bcrypt.hash(user.password, 10);

    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        passwordHash,
      },
      create: {
        name: user.name,
        email: user.email,
        role: user.role,
        passwordHash,
      },
    });
  }

  console.log(
    "Seed executado com sucesso: ADMIN, FUNCIONARIO, COZINHA e CLIENTE.",
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
