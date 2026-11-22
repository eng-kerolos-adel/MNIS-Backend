import {
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Injectable,
  Module,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NotifType } from '@prisma/client';
import { IsString, IsEnum, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { Audit, AllowUnverifiedPhone, CurrentUser, AuthUser } from '../common/decorators';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';

// --- DTOs ---
export class RegisterTokenDto {
  @IsString()
  token: string;

  @IsString()
  platform: string; // 'android' | 'ios'
}

export class UnregisterTokenDto {
  @IsString()
  token: string;
}

// --- Service ---
@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseAdminService,
  ) {}

  async registerToken(userId: string, token: string, platform: string) {
    return this.prisma.pushToken.upsert({
      where: { token },
      update: { userId, platform, updatedAt: new Date() },
      create: { userId, token, platform },
    });
  }

  async unregisterToken(userId: string, token: string) {
    return this.prisma.pushToken.deleteMany({
      where: { token, userId },
    });
  }

  async sendToUserWithDelivery(
    userId: string,
    type: NotifType,
    titleEn: string,
    titleAr: string,
    bodyEn: string,
    bodyAr: string,
    data: any = {},
  ) {
    const notif = await this.prisma.pushNotification.create({
      data: {
        userId,
        type,
        titleEn,
        titleAr,
        bodyEn,
        bodyAr,
        data,
      },
    });

    const [tokens, unreadCount] = await Promise.all([
      this.prisma.pushToken.findMany({ where: { userId } }),
      this.prisma.pushNotification.count({ where: { userId, readAt: null } }),
    ]);

    const payloadData = data && typeof data === 'object' ? data : {};
    const [, delivery] = await Promise.all([
      this.firebase.pushUserSignal(userId, type, unreadCount).catch(() => undefined),
      tokens.length > 0
        ? this.firebase.sendPushNotification(
            tokens.map((t) => t.token),
            { titleEn, titleAr, bodyEn, bodyAr, type, data: payloadData },
          )
        : Promise.resolve({ sent: 0, invalidTokens: [] as string[] }),
    ]);

    if (delivery.invalidTokens.length > 0) {
      await this.prisma.pushToken.deleteMany({
        where: { token: { in: delivery.invalidTokens } },
      });
    }

    return {
      notification: notif,
      tokensCount: tokens.length,
      delivery,
    };
  }

  async sendToUser(
    userId: string,
    type: NotifType,
    titleEn: string,
    titleAr: string,
    bodyEn: string,
    bodyAr: string,
    data: any = {},
  ) {
    const { notification } = await this.sendToUserWithDelivery(
      userId,
      type,
      titleEn,
      titleAr,
      bodyEn,
      bodyAr,
      data,
    );
    return notification;
  }

  async getMyNotifications(userId: string) {
    return this.prisma.pushNotification.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      take: 50,
    });
  }

  async markRead(userId: string, notifId: string) {
    const res = await this.prisma.pushNotification.updateMany({
      where: { id: notifId, userId },
      data: { readAt: new Date() },
    });
    const unreadCount = await this.prisma.pushNotification.count({
      where: { userId, readAt: null },
    });
    await this.firebase.pushUserSignal(userId, 'READ', unreadCount).catch(() => undefined);
    return res;
  }
}

// --- Controller ---
@ApiTags('notifications')
@ApiBearerAuth()
@Audit('NOTIFICATION')
@Controller('notifications')
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @AllowUnverifiedPhone()
  @Post('token')
  registerToken(@Body() dto: RegisterTokenDto, @CurrentUser() user: AuthUser) {
    return this.svc.registerToken(user.id, dto.token, dto.platform);
  }

  @AllowUnverifiedPhone()
  @Delete('token')
  unregisterToken(@Body() dto: UnregisterTokenDto, @CurrentUser() user: AuthUser) {
    return this.svc.unregisterToken(user.id, dto.token);
  }

  @Get()
  getMyNotifications(@CurrentUser() user: AuthUser) {
    return this.svc.getMyNotifications(user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.markRead(user.id, id);
  }
}

// --- Module ---
@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
