import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Body,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NfcCardStatus, NotifType, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { Audit, CurrentUser, AuthUser, Roles } from '../common/decorators';
import { generateTempPassword } from '../common/password.util';
import { assertPhoneAvailable, maskPhone, normalizePhoneE164, rethrowPhoneConflict } from '../common/phone.util';
import { PatientsModule } from '../patients/patients.module';
import { PATIENT_PUBLIC_SELECT } from '../patients/patient.select';
import { CreatePatientDto, PatientsService } from '../patients/patients.service';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

export class UpdateCitizenPhoneDto {
  @IsString()
  @MaxLength(20)
  phone: string;
}

export class UpdateCitizenAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  governorate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  district?: string;

  @IsString()
  @Length(3, 200)
  addressAr: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressEn?: string;
}

export class UpdateCitizenPhotoDto {
  @IsString()
  @Length(10, 2000000)
  photoUrl: string;
}

export class RequestCitizenDeletionDto {
  @IsString()
  @Length(3, 300)
  reason: string;
}

export class SendCitizenPushDto {
  @IsString()
  @Length(2, 120)
  titleAr: string;

  @IsString()
  @Length(2, 120)
  titleEn: string;

  @IsString()
  @Length(2, 500)
  bodyAr: string;

  @IsString()
  @Length(2, 500)
  bodyEn: string;
}

/** Citizens cannot self-register: reception opens the account on the first visit and hands over a one-time temporary password + NFC emergency token. */
@Injectable()
export class ReceptionService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private patients: PatientsService,
    private notifs: NotificationsService,
  ) {}

  async openAccount(dto: CreatePatientDto, receptionistId?: string) {
    const normalizedPhone = normalizePhoneE164(dto.phone);
    const existing = await this.prisma.patient.findUnique({
      where: { nationalIdIdx: this.crypto.blindIndex(dto.nationalId) },
    });
    let patient = existing ?? (await this.patients.create(dto));
    if (existing) {
      const addressAr = dto.addressAr?.trim() || dto.addressEn?.trim();
      const addressEn = dto.addressEn?.trim() || dto.addressAr?.trim();
      const phoneChanged = Boolean(normalizedPhone && existing.phone !== normalizedPhone);
      if (phoneChanged) {
        await assertPhoneAvailable(this.prisma, normalizedPhone, existing.id);
      }
      const cleanPhotoUrl = dto.photoUrl?.trim() || undefined;
      if (phoneChanged || addressAr || dto.governorate || dto.district || cleanPhotoUrl) {
        try {
          patient = await this.prisma.patient.update({
            where: { id: existing.id },
            data: {
              ...(phoneChanged ? { phone: normalizedPhone, phoneVerifiedAt: null } : {}),
              ...(dto.governorate ? { governorate: dto.governorate } : {}),
              ...(dto.district ? { district: dto.district } : {}),
              ...(addressAr ? { addressAr, addressEn } : {}),
              ...(cleanPhotoUrl ? { photoUrl: cleanPhotoUrl } : {}),
            },
          });
        } catch (err) {
          rethrowPhoneConflict(err);
        }
      }
    }
    if (await this.prisma.user.findUnique({ where: { patientId: patient.id } })) {
      throw new ConflictException('ACCOUNT_ALREADY_EXISTS');
    }
    const temp = generateTempPassword();
    await this.prisma.user.create({
      data: {
        role: Role.PATIENT,
        patientId: patient.id,
        fullNameEn: patient.fullNameEn,
        fullNameAr: patient.fullNameAr,
        passwordHash: await argon2.hash(temp),
        mustChangePassword: true,
      },
    });

    // Automatically issue an active NFC card for the citizen on account opening
    const rawNfcToken = randomBytes(32).toString('hex').toUpperCase();
    const tokenHash = this.crypto.sha256(rawNfcToken);
    const activeCard = await this.prisma.nfcCard.findFirst({
      where: { patientId: patient.id, status: NfcCardStatus.ACTIVE },
    });
    if (!activeCard) {
      await this.prisma.nfcCard.create({
        data: {
          patientId: patient.id,
          tokenHash,
          status: NfcCardStatus.ACTIVE,
          printedById: receptionistId ?? null,
        },
      });
    }

    return {
      patientId: patient.id,
      mti: patient.mti,
      loginId: dto.nationalId,
      phone: patient.phone ?? null,
      temporaryPassword: temp,
      nfcToken: activeCard ? undefined : rawNfcToken,
    };
  }

  async resetCitizenPassword(patientId: string) {
    const user = await this.prisma.user.findUnique({ where: { patientId } });
    if (!user) throw new NotFoundException('NO_ACCOUNT_FOR_PATIENT');
    const temp = generateTempPassword();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await argon2.hash(temp),
          mustChangePassword: true,
          failedLogins: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { temporaryPassword: temp };
  }

  async updateCitizenPhone(patientId: string, rawPhone: string) {
    const normalized = normalizePhoneE164(rawPhone);
    if (!normalized) throw new BadRequestException('INVALID_PHONE_NUMBER');

    const patient = await this.prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');

    const changed = patient.phone !== normalized;
    if (changed) await assertPhoneAvailable(this.prisma, normalized, patientId);
    let updated: { id: string; phone: string | null; phoneVerifiedAt: Date | null };
    try {
      updated = await this.prisma.patient.update({
        where: { id: patientId },
        data: {
          phone: normalized,
          ...(changed ? { phoneVerifiedAt: null } : {}),
        },
        select: { id: true, phone: true, phoneVerifiedAt: true },
      });
    } catch (err) {
      rethrowPhoneConflict(err);
    }

    if (changed) {
      const citizenUser = await this.prisma.user.findUnique({
        where: { patientId },
        select: { id: true },
      });
      if (citizenUser) {
        await this.notifs
          .sendToUser(
            citizenUser.id,
            NotifType.GENERAL,
            'Phone Number Updated',
            'تم تسجيل رقم هاتفك في الاستقبال',
            'Reception registered your mobile number. Please confirm it by SMS inside the MNIS app to continue.',
            'قام مكتب الاستقبال بتسجيل رقم هاتفك. يرجى تأكيده بكود SMS داخل تطبيق MNIS للمتابعة.',
            { event: 'PHONE_UPDATED' },
          )
          .catch(() => undefined);
      }
    }

    return {
      patientId: updated.id,
      phone: updated.phone,
      phoneMasked: maskPhone(updated.phone),
      phoneVerifiedAt: updated.phoneVerifiedAt,
    };
  }

  async sendCitizenPush(patientId: string, dto: SendCitizenPushDto) {
    const citizenUser = await this.prisma.user.findUnique({
      where: { patientId },
      select: { id: true },
    });
    if (!citizenUser) throw new NotFoundException('NO_ACCOUNT_FOR_PATIENT');

    const { notification, tokensCount, delivery } = await this.notifs.sendToUserWithDelivery(
      citizenUser.id,
      NotifType.GENERAL,
      dto.titleEn.trim(),
      dto.titleAr.trim(),
      dto.bodyEn.trim(),
      dto.bodyAr.trim(),
      { event: 'RECEPTION_MESSAGE' },
    );
    return {
      ok: true,
      notificationId: notification.id,
      tokensCount,
      sent: delivery.sent,
    };
  }

  async updateCitizenAddress(patientId: string, dto: UpdateCitizenAddressDto) {
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');

    const cleanAr = dto.addressAr.trim();
    const cleanEn = dto.addressEn?.trim() || cleanAr;
    return this.prisma.patient.update({
      where: { id: patientId },
      data: {
        ...(dto.governorate !== undefined ? { governorate: dto.governorate.trim() || null } : {}),
        ...(dto.district !== undefined ? { district: dto.district.trim() || null } : {}),
        addressAr: cleanAr,
        addressEn: cleanEn,
      },
      select: PATIENT_PUBLIC_SELECT,
    });
  }

  async updateCitizenPhoto(patientId: string, photoUrl: string) {
    const clean = photoUrl?.trim();
    if (!clean || (!clean.startsWith('data:image/') && !clean.startsWith('http'))) {
      throw new BadRequestException('INVALID_PHOTO_FORMAT');
    }
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');

    return this.prisma.patient.update({
      where: { id: patientId },
      data: { photoUrl: clean },
      select: PATIENT_PUBLIC_SELECT,
    });
  }

  listPendingDeletionRequests() {
    return this.prisma.patient.findMany({
      where: { deletionRequestedAt: { not: null } },
      orderBy: { deletionRequestedAt: 'desc' },
      select: PATIENT_PUBLIC_SELECT,
    });
  }

  async requestCitizenDeletion(patientId: string, reason: string, actor?: AuthUser) {
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');

    const actorUser = actor?.id
      ? await this.prisma.user.findUnique({
          where: { id: actor.id },
          select: { fullNameAr: true, fullNameEn: true },
        })
      : null;

    const requestedByName = actorUser
      ? `${actorUser.fullNameAr} (${actorUser.fullNameEn})`
      : (actor?.role ?? 'RECEPTIONIST');

    return this.prisma.patient.update({
      where: { id: patientId },
      data: {
        deletionRequestedAt: new Date(),
        deletionReason: reason.trim(),
        deletionRequestedById: actor?.id ?? null,
        deletionRequestedByName: requestedByName,
      },
      select: PATIENT_PUBLIC_SELECT,
    });
  }

  async rejectCitizenDeletion(patientId: string) {
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');

    return this.prisma.patient.update({
      where: { id: patientId },
      data: {
        deletionRequestedAt: null,
        deletionReason: null,
        deletionRequestedById: null,
        deletionRequestedByName: null,
      },
      select: PATIENT_PUBLIC_SELECT,
    });
  }

  async approveCitizenDeletion(patientId: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, mti: true, deletionRequestedAt: true },
    });
    if (!patient) throw new NotFoundException('PATIENT_NOT_FOUND');
    if (!patient.deletionRequestedAt) {
      throw new BadRequestException('NO_DELETION_REQUEST_PENDING');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orCase.deleteMany({ where: { patientId } });
      await tx.bed.updateMany({
        where: { patientId },
        data: { patientId: null, status: 'AVAILABLE', acuity: null, admittedAt: null },
      });
      await tx.erCase.deleteMany({ where: { patientId } });
      await tx.conditionFlag.deleteMany({ where: { patientId } });
      await tx.labSample.deleteMany({ where: { patientId } });
      await tx.radiologyUpload.deleteMany({ where: { patientId } });
      await tx.renewalRequest.deleteMany({ where: { patientId } });
      await tx.pharmacyClaim.deleteMany({ where: { patientId } });
      await tx.chronicAllowance.deleteMany({ where: { patientId } });
      await tx.prescription.deleteMany({ where: { patientId } });
      await tx.visit.deleteMany({ where: { patientId } });
      await tx.appointment.deleteMany({ where: { patientId } });
      await tx.referral.deleteMany({ where: { patientId } });
      await tx.document.deleteMany({ where: { patientId } });
      await tx.shareToken.deleteMany({ where: { patientId } });
      await tx.nfcCard.deleteMany({ where: { patientId } });

      const citizenUser = await tx.user.findUnique({
        where: { patientId },
        select: { id: true },
      });
      if (citizenUser) {
        await tx.pushNotification.deleteMany({ where: { userId: citizenUser.id } });
        await tx.user.delete({ where: { id: citizenUser.id } });
      }

      await tx.patient.delete({ where: { id: patientId } });
    });

    return { deleted: true, patientId, mti: patient.mti };
  }
}

@ApiTags('reception')
@ApiBearerAuth()
@Audit('CITIZEN_ACCOUNT')
@Roles(Role.RECEPTIONIST)
@Controller('reception/citizens')
export class ReceptionController {
  constructor(private svc: ReceptionService) {}

  @Get('deletion-requests')
  @Roles(Role.RECEPTIONIST, Role.EXECUTIVE)
  listDeletionRequests() {
    return this.svc.listPendingDeletionRequests();
  }

  @Post()
  @Roles(Role.RECEPTIONIST)
  open(@Body() dto: CreatePatientDto, @CurrentUser() u: AuthUser) {
    return this.svc.openAccount(dto, u?.id);
  }

  @Post(':patientId/reset-password')
  @Roles(Role.RECEPTIONIST)
  reset(@Param('patientId', ParseUUIDPipe) id: string) {
    return this.svc.resetCitizenPassword(id);
  }

  @Patch(':patientId/phone')
  @Roles(Role.RECEPTIONIST)
  updatePhone(
    @Param('patientId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCitizenPhoneDto,
  ) {
    return this.svc.updateCitizenPhone(id, dto.phone);
  }

  @Patch(':patientId/address')
  @Roles(Role.RECEPTIONIST)
  updateAddress(
    @Param('patientId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCitizenAddressDto,
  ) {
    return this.svc.updateCitizenAddress(id, dto);
  }

  @Patch(':patientId/photo')
  @Roles(Role.RECEPTIONIST)
  updatePhoto(
    @Param('patientId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCitizenPhotoDto,
  ) {
    return this.svc.updateCitizenPhoto(id, dto.photoUrl);
  }

  @Post(':patientId/deletion-request')
  @Roles(Role.RECEPTIONIST)
  requestDeletion(
    @Param('patientId', ParseUUIDPipe) id: string,
    @Body() dto: RequestCitizenDeletionDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.svc.requestCitizenDeletion(id, dto.reason, u);
  }

  @Post(':patientId/deletion-reject')
  @Roles(Role.RECEPTIONIST, Role.EXECUTIVE)
  rejectDeletion(@Param('patientId', ParseUUIDPipe) id: string) {
    return this.svc.rejectCitizenDeletion(id);
  }

  @Post(':patientId/deletion-approve')
  @Roles(Role.EXECUTIVE)
  approveDeletion(@Param('patientId', ParseUUIDPipe) id: string) {
    return this.svc.approveCitizenDeletion(id);
  }

  @Post(':patientId/notify')
  @Roles(Role.RECEPTIONIST)
  notifyCitizen(
    @Param('patientId', ParseUUIDPipe) id: string,
    @Body() dto: SendCitizenPushDto,
  ) {
    return this.svc.sendCitizenPush(id, dto);
  }
}

@Module({
  imports: [PatientsModule, NotificationsModule],
  controllers: [ReceptionController],
  providers: [ReceptionService],
})
export class ReceptionModule {}
