import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const rawPassword = process.env.SEED_PASSWORD;
  if (!rawPassword || rawPassword.length < 12) {
    throw new Error('Set SEED_PASSWORD env var (12+ chars) before running quick-seed.');
  }
  const passwordHash = await argon2.hash(rawPassword);

  const adminEmail = 'admin@mnis.gov.eg';
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      role: 'ADMIN',
      fullNameEn: 'System Admin',
      fullNameAr: 'مدير النظام',
    },
  });

  const receptionEmail = 'reception@mnis.gov.eg';
  const receptionist = await prisma.user.upsert({
    where: { email: receptionEmail },
    update: {},
    create: {
      email: receptionEmail,
      passwordHash,
      role: 'RECEPTIONIST',
      fullNameEn: 'Main Receptionist',
      fullNameAr: 'موظف الاستقبال',
    },
  });

  console.log('Seeded institutional accounts:', admin.email, receptionist.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
