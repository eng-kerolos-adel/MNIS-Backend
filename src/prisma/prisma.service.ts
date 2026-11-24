import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          throw err;
        }
        this.logger.warn(
          `Database connection attempt ${attempt}/${maxAttempts} failed; retrying in 1500ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
