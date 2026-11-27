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
import { NotifType, Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { Audit, AllowUnverifiedPhone, CurrentUser, AuthUser, Roles } from '../common/decorators';
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

export class EmergencyAlertDto {
  @IsIn(['CRITICAL', 'URGENT'])
  severity: 'CRITICAL' | 'URGENT';

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  location: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  patientMti?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  details: string;
}

export interface PortalNotificationItem {
  id: string;
  userId: string;
  type: NotifType;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  data: Record<string, unknown>;
  sentAt: Date | string;
  readAt: Date | string | null;
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

  async getMyNotifications(user: AuthUser): Promise<PortalNotificationItem[]> {
    const persisted = await this.prisma.pushNotification.findMany({
      where: { userId: user.id },
      orderBy: { sentAt: 'desc' },
      take: 50,
    });

    return persisted.map((n) => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      titleEn: n.titleEn,
      titleAr: n.titleAr,
      bodyEn: n.bodyEn,
      bodyAr: n.bodyAr,
      data: (n.data && typeof n.data === 'object' ? n.data : {}) as Record<string, unknown>,
      sentAt: n.sentAt,
      readAt: n.readAt,
    }));
  }

  async notifyManyUsers(
    userIds: string[],
    type: NotifType,
    titleEn: string,
    titleAr: string,
    bodyEn: string,
    bodyAr: string,
    data: Record<string, unknown> = {},
  ) {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    if (unique.length === 0) return [];
    return Promise.all(
      unique.map((uid) =>
        this.sendToUser(uid, type, titleEn, titleAr, bodyEn, bodyAr, data).catch(() => undefined),
      ),
    );
  }

  async notifyRoles(
    roles: Role[],
    type: NotifType,
    titleEn: string,
    titleAr: string,
    bodyEn: string,
    bodyAr: string,
    data: Record<string, unknown> = {},
    facilityEn?: string | null,
  ) {
    const cleanFac = facilityEn?.trim();
    let targets = await this.prisma.user.findMany({
      where: {
        role: { in: roles },
        isActive: true,
        ...(cleanFac ? { facilityEn: cleanFac } : {}),
      },
      select: { id: true },
      take: 50,
    });
    if (cleanFac && targets.length === 0) {
      targets = await this.prisma.user.findMany({
        where: { role: { in: roles }, isActive: true },
        select: { id: true },
        take: 50,
      });
    }
    return this.notifyManyUsers(
      targets.map((u) => u.id),
      type,
      titleEn,
      titleAr,
      bodyEn,
      bodyAr,
      data,
    );
  }

  async testSelfNotification(user: AuthUser) {
    const notif = await this.sendToUser(
      user.id,
      NotifType.GENERAL,
      'Live MNIS Browser Alert Verified',
      'تم التحقق من نظام الإشعارات الفورية بنجاح ✓',
      'Real-time notifications from MNIS Portal are connected to your browser.',
      'نظام الإشعارات الفورية في بوابة MNIS متصل بنجاح ويعمل لحظياً داخل المتصفح.',
      { category: 'SYSTEM_TEST', href: '/notifications', severity: 'INFO' },
    );
    return { ok: true, notification: notif };
  }

  async dispatchEmergencyAlert(user: AuthUser, dto: EmergencyAlertDto) {
    const sender = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, fullNameEn: true, fullNameAr: true, facilityEn: true, facilityAr: true },
    });
    const senderNameEn = sender?.fullNameEn || 'MNIS Staff';
    const senderNameAr = sender?.fullNameAr || 'أحد كوادر المنظومة';
    const facilityEn = sender?.facilityEn?.trim();

    let responders = facilityEn
      ? await this.prisma.user.findMany({
          where: {
            isActive: true,
            role: { in: [Role.HOSPITAL_STAFF, Role.DOCTOR, Role.ADMIN] },
            facilityEn,
          },
          select: { id: true, role: true },
          take: 30,
        })
      : [];

    if (responders.length < 3) {
      const extra = await this.prisma.user.findMany({
        where: {
          isActive: true,
          role: { in: [Role.HOSPITAL_STAFF, Role.DOCTOR, Role.ADMIN] },
          id: { notIn: responders.map((r) => r.id) },
        },
        select: { id: true, role: true },
        take: 30 - responders.length,
      });
      responders = [...responders, ...extra];
    }

    const recipientMap = new Map<string, Role>();
    for (const r of responders) recipientMap.set(r.id, r.role);
    recipientMap.set(user.id, user.role);

    const sevAr = dto.severity === 'CRITICAL' ? 'حرج جداً — استنفار فوري' : 'عاجل';
    const titleAr = `🚨 نداء طوارئ فوري (${sevAr}) — ${dto.location.trim()}`;
    const titleEn = `🚨 Instant Emergency Alert (${dto.severity}) — ${dto.location.trim()}`;
    const mtiTagAr = dto.patientMti?.trim() ? ` | المواطن: ${dto.patientMti.trim()}` : '';
    const mtiTagEn = dto.patientMti?.trim() ? ` | Citizen: ${dto.patientMti.trim()}` : '';
    const bodyAr = `${dto.details.trim()}${mtiTagAr} — المرسل: ${senderNameAr}`;
    const bodyEn = `${dto.details.trim()}${mtiTagEn} — From: ${senderNameEn}`;

    const roleHref = (r: Role): string => {
      if (r === Role.HOSPITAL_STAFF) return '/hospital/er-triage';
      if (r === Role.DOCTOR) return '/doctor/consultation';
      if (r === Role.PHARMACIST) return '/pharmacy/dispensing-queue';
      if (r === Role.LAB_TECH) return '/lab/sample-intake';
      if (r === Role.RECEPTIONIST) return '/reception/citizens';
      if (r === Role.EXECUTIVE) return '/analytics/facility-capacity';
      return '/admin/users';
    };

    const recipients = Array.from(recipientMap.entries());
    await this.prisma.pushNotification.createMany({
      data: recipients.map(([recipientId, recipientRole]) => ({
        userId: recipientId,
        type: NotifType.EMERGENCY_ALERT,
        titleEn,
        titleAr,
        bodyEn,
        bodyAr,
        data: {
          category: 'EMERGENCY_ALERT',
          severity: dto.severity,
          location: dto.location.trim(),
          patientMti: dto.patientMti?.trim() || null,
          senderId: user.id,
          senderNameAr,
          href: roleHref(recipientRole),
        },
      })),
    });

    await Promise.all(
      recipients.map(([recipientId]) =>
        this.firebase.pushUserSignal(recipientId, 'EMERGENCY_ALERT', 1).catch(() => undefined),
      ),
    );

    return {
      ok: true,
      dispatchedCount: recipients.length,
      timestamp: new Date().toISOString(),
    };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.pushNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    await this.firebase.pushUserSignal(userId, 'READ_ALL', 0).catch(() => undefined);
    return { ok: true, count: res.count };
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
    return this.svc.getMyNotifications(user);
  }

  @Post('test-self')
  testSelf(@CurrentUser() user: AuthUser) {
    return this.svc.testSelfNotification(user);
  }

  @Post('emergency-alert')
  @Roles(Role.DOCTOR, Role.HOSPITAL_STAFF, Role.LAB_TECH, Role.PHARMACIST, Role.RECEPTIONIST, Role.EXECUTIVE, Role.ADMIN)
  dispatchEmergencyAlert(@Body() dto: EmergencyAlertDto, @CurrentUser() user: AuthUser) {
    return this.svc.dispatchEmergencyAlert(user, dto);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.svc.markAllRead(user.id);
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
