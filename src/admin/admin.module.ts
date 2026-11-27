import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AddressChangeStatus, NotifType, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, AuthUser, CurrentUser, Roles } from '../common/decorators';
import { generateTempPassword } from '../common/password.util';
import { getGovernorateMeta, inferLocationFromFacilityText, normalizeGovernorate } from '../common/egypt-geo.util';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

const STAFF_ROLES = ['DOCTOR', 'PHARMACIST', 'LAB_TECH', 'HOSPITAL_STAFF', 'EXECUTIVE', 'RECEPTIONIST', 'ADMIN'] as const;

export class CreateStaffDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsIn(STAFF_ROLES as unknown as string[]) role: (typeof STAFF_ROLES)[number];
  @IsString() @Length(2, 120) fullNameEn: string;
  @IsString() @Length(2, 120) fullNameAr: string;
  @IsOptional() @IsString() @MaxLength(60) licenseNo?: string;
  @IsOptional() @IsString() @MaxLength(120) specialityEn?: string;
  @IsOptional() @IsString() @MaxLength(120) specialityAr?: string;
  @IsOptional() @IsString() @MaxLength(160) facilityEn?: string;
  @IsOptional() @IsString() @MaxLength(160) facilityAr?: string;
  @IsOptional() @IsString() @MaxLength(80) governorate?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) district?: string;
  @IsOptional() @IsString() @MaxLength(200) addressEn?: string;
  @IsOptional() @IsString() @MaxLength(200) addressAr?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
}
export class ActiveDto { @IsBoolean() isActive: boolean; }

export class UpdateLocationDto {
  @IsString() @MaxLength(80) governorate: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(80) district?: string;
  @IsString() @Length(3, 200) addressAr: string;
  @IsOptional() @IsString() @MaxLength(200) addressEn?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsBoolean() applyToFacility?: boolean;
}

export class ReviewAddressChangeDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CreateFacilityBundleDto {
  @IsIn(['CLINIC', 'LAB', 'HOSPITAL', 'PHARMACY'])
  facilityType: 'CLINIC' | 'LAB' | 'HOSPITAL' | 'PHARMACY';

  @IsOptional()
  @IsIn(['ANALYSIS', 'RADIOLOGY'])
  labSubType?: 'ANALYSIS' | 'RADIOLOGY';

  @IsString() @Length(2, 160)
  facilityEn: string;

  @IsString() @Length(2, 160)
  facilityAr: string;

  @IsEmail() @MaxLength(254)
  primaryEmail: string;

  @IsString() @Length(2, 120)
  primaryNameEn: string;

  @IsString() @Length(2, 120)
  primaryNameAr: string;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.trim().length > 0)
  @IsEmail()
  @MaxLength(254)
  secondaryEmail?: string;

  @IsOptional() @IsString() @MaxLength(120)
  secondaryNameEn?: string;

  @IsOptional() @IsString() @MaxLength(120)
  secondaryNameAr?: string;

  @IsOptional() @IsString() @MaxLength(120)
  specialityEn?: string;

  @IsOptional() @IsString() @MaxLength(120)
  specialityAr?: string;

  @IsOptional() @IsString() @MaxLength(60)
  licenseNo?: string;

  @IsOptional() @IsString() @MaxLength(80)
  governorate?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(80)
  district?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressEn?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressAr?: string;

  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number;
}

const SELECT = {
  id: true, email: true, role: true, fullNameEn: true, fullNameAr: true, licenseNo: true,
  specialityEn: true, specialityAr: true, facilityEn: true, facilityAr: true,
  governorate: true, city: true, district: true, addressEn: true, addressAr: true,
  latitude: true, longitude: true,
  isActive: true, mustChangePassword: true, failedLogins: true, lockedUntil: true, createdAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notifs: NotificationsService,
  ) {}

  private resolveLocationFields(input: {
    governorate?: string;
    city?: string;
    district?: string;
    addressEn?: string;
    addressAr?: string;
    latitude?: number;
    longitude?: number;
    facilityEn?: string;
    facilityAr?: string;
  }) {
    const inferred = inferLocationFromFacilityText(input.facilityEn, input.facilityAr);
    const normGov =
      normalizeGovernorate(input.governorate) ??
      normalizeGovernorate(input.addressAr) ??
      normalizeGovernorate(input.addressEn) ??
      inferred.governorate;
    const meta = getGovernorateMeta(normGov);
    const lat = typeof input.latitude === 'number' ? input.latitude : meta?.lat ?? inferred.latitude;
    const lng = typeof input.longitude === 'number' ? input.longitude : meta?.lng ?? inferred.longitude;
    const addrAr = input.addressAr?.trim() || (meta ? `${input.facilityAr?.trim() || ''}${input.facilityAr ? ' — ' : ''}${input.district ? `${input.district}، ` : ''}${meta.ar}` : inferred.addressAr);
    const addrEn = input.addressEn?.trim() || input.addressAr?.trim() || (meta ? `${input.facilityEn?.trim() || ''}${input.facilityEn ? ', ' : ''}${input.district ? `${input.district}, ` : ''}${meta.en}` : inferred.addressEn);
    return {
      governorate: normGov,
      city: input.city?.trim() || meta?.en || null,
      district: input.district?.trim() || null,
      addressAr: addrAr || null,
      addressEn: addrEn || null,
      latitude: lat,
      longitude: lng,
    };
  }

  list() { return this.prisma.user.findMany({ where: { role: { not: Role.PATIENT } }, select: SELECT, orderBy: { createdAt: 'desc' }, take: 200 }); }

  async create(dto: CreateStaffDto) {
    const temp = generateTempPassword();
    const loc = this.resolveLocationFields(dto);
    const user = await this.prisma.user.create({
      data: { ...dto, ...loc, email: dto.email.toLowerCase(), passwordHash: await argon2.hash(temp), mustChangePassword: true },
      select: SELECT,
    });
    // The temporary password is shown exactly once and never stored in clear.
    return { user, temporaryPassword: temp };
  }

  async setActive(id: string, isActive: boolean, actorId?: string) {
    if (actorId && id === actorId && !isActive) {
      throw new BadRequestException('CANNOT_DEACTIVATE_SELF');
    }
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.role === Role.PATIENT) throw new NotFoundException();
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { isActive }, select: SELECT }),
      ...(isActive ? [] : [this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })]),
    ]);
    return user;
  }

  async resetPassword(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.role === Role.PATIENT) throw new NotFoundException();
    const temp = generateTempPassword();
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash: await argon2.hash(temp), mustChangePassword: true, failedLogins: 0, lockedUntil: null } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { temporaryPassword: temp };
  }

  async deleteStaff(id: string, actorId: string) {
    if (id === actorId) {
      throw new BadRequestException('CANNOT_DELETE_SELF');
    }
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, fullNameEn: true } });
    if (!target || target.role === Role.PATIENT) {
      throw new NotFoundException('STAFF_NOT_FOUND');
    }

    await this.prisma.$transaction([
      this.prisma.pushNotification.deleteMany({ where: { userId: id } }),
      this.prisma.doctorSchedule.deleteMany({ where: { doctorId: id } }),
      this.prisma.refreshToken.deleteMany({ where: { userId: id } }),
      this.prisma.pushToken.deleteMany({ where: { userId: id } }),

      this.prisma.appointment.updateMany({ where: { doctorId: id }, data: { doctorId: null } }),
      this.prisma.appointment.updateMany({ where: { decidedById: id }, data: { decidedById: null } }),
      this.prisma.visit.updateMany({ where: { doctorId: id }, data: { doctorId: null } }),
      this.prisma.prescription.updateMany({ where: { verifiedById: id }, data: { verifiedById: null } }),
      this.prisma.prescription.updateMany({ where: { dispensedById: id }, data: { dispensedById: null } }),
      this.prisma.renewalRequest.updateMany({ where: { decidedById: id }, data: { decidedById: null } }),
      this.prisma.labSample.updateMany({ where: { enteredById: id }, data: { enteredById: null } }),
      this.prisma.labSample.updateMany({ where: { verifiedById: id }, data: { verifiedById: null } }),
      this.prisma.conditionFlag.updateMany({ where: { reviewedById: id }, data: { reviewedById: null } }),
      this.prisma.referral.updateMany({ where: { decidedById: id }, data: { decidedById: null } }),
      this.prisma.document.updateMany({ where: { reviewedById: id }, data: { reviewedById: null } }),
      this.prisma.shareToken.updateMany({ where: { usedById: id }, data: { usedById: null } }),
      this.prisma.nfcCard.updateMany({ where: { printedById: id }, data: { printedById: null } }),
      this.prisma.nfcCard.updateMany({ where: { revokedById: id }, data: { revokedById: null } }),
      this.prisma.pharmacySettlement.updateMany({ where: { submittedById: id }, data: { submittedById: null } }),
      this.prisma.patient.updateMany({ where: { deletionRequestedById: id }, data: { deletionRequestedById: null } }),

      this.prisma.referral.updateMany({ where: { senderId: id }, data: { senderId: actorId } }),
      this.prisma.prescription.updateMany({ where: { physicianId: id }, data: { physicianId: actorId } }),
      this.prisma.pharmacyClaim.updateMany({ where: { dispensedById: id }, data: { dispensedById: actorId } }),
      this.prisma.labSample.updateMany({ where: { orderedById: id }, data: { orderedById: actorId } }),
      this.prisma.conditionFlag.updateMany({ where: { flaggedById: id }, data: { flaggedById: actorId } }),
      this.prisma.calibrationRecord.updateMany({ where: { performedById: id }, data: { performedById: actorId } }),
      this.prisma.radiologyUpload.updateMany({ where: { uploadedById: id }, data: { uploadedById: actorId } }),
      this.prisma.orCase.updateMany({ where: { surgeonId: id }, data: { surgeonId: actorId } }),
      this.prisma.orCase.updateMany({ where: { createdById: id }, data: { createdById: actorId } }),

      this.prisma.user.delete({ where: { id } }),
    ]);

    return { ok: true, deletedId: id, email: target.email };
  }

  async getAuditLogs() {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { at: 'desc' },
      take: 100,
    });
    const userIds = Array.from(new Set(logs.map((l) => l.userId).filter((x): x is string => !!x)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, fullNameEn: true, fullNameAr: true, role: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return logs.map((l) => ({
      ...l,
      createdAt: l.at,
      actor: l.userId ? userMap.get(l.userId) ?? null : null,
    }));
  }

  async getSecurityPosture() {
    const [
      totalAuditLogs,
      failedRequests,
      activeSessions,
      lockedAccounts,
      activeNfcCards,
      revokedNfcCards,
      signedPrescriptions,
      totalPatients,
    ] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.count({ where: { statusCode: { gte: 400 } } }),
      this.prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: new Date() } } }),
      this.prisma.nfcCard.count({ where: { status: 'ACTIVE' } }),
      this.prisma.nfcCard.count({ where: { status: { not: 'ACTIVE' } } }),
      this.prisma.prescription.count({ where: { signatureHash: { not: null } } }),
      this.prisma.patient.count(),
    ]);

    return {
      encryptionStandard: 'AES-256-GCM (Authenticated Field-Level Encryption)',
      blindIndexStandard: 'HMAC-SHA256 (O(1) Constant-Time National ID Lookup)',
      passwordStandard: 'Argon2id + 5-Strike Brute-Force Lockout',
      rxSignatureStandard: 'HMAC-SHA256 Canonical Digital Seal',
      nationalScaleCapacity: 120_000_000,
      governorateShards: 27,
      totalAuditLogs,
      failedRequests,
      activeSessions,
      lockedAccounts,
      activeNfcCards,
      revokedNfcCards,
      signedPrescriptions,
      totalPatients,
      checkedAt: new Date().toISOString(),
    };
  }

  async listFacilities() {
    const staff = await this.prisma.user.findMany({
      where: { role: { not: Role.PATIENT } },
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });

    const groups = new Map<
      string,
      {
        key: string;
        facilityEn: string;
        facilityAr: string;
        staff: typeof staff;
      }
    >();

    for (const u of staff) {
      const en = u.facilityEn?.trim() || 'National Health Command';
      const ar = u.facilityAr?.trim() || 'المركز القومي للمنظومة الصحية';
      const key = en.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.staff.push(u);
      } else {
        groups.set(key, { key, facilityEn: en, facilityAr: ar, staff: [u] });
      }
    }

    return Array.from(groups.values()).map((g) => {
      const roles = new Set(g.staff.map((s) => s.role));
      const hasAssistant = g.staff.some((s) => s.specialityEn === 'CLINIC_ASSISTANT');
      const isRadiology = g.staff.some(
        (s) =>
          s.specialityEn?.toUpperCase().startsWith('RADIOLOGY') ||
          s.licenseNo?.toUpperCase().startsWith('RAD-'),
      );
      let facilityType: 'CLINIC' | 'LAB' | 'RADIOLOGY' | 'HOSPITAL' | 'PHARMACY' | 'RECEPTION' | 'COMMAND' = 'COMMAND';
      if (roles.has(Role.HOSPITAL_STAFF)) {
        facilityType = 'HOSPITAL';
      } else if (roles.has(Role.LAB_TECH)) {
        facilityType = isRadiology ? 'RADIOLOGY' : 'LAB';
      } else if (hasAssistant || roles.has(Role.DOCTOR)) {
        facilityType = 'CLINIC';
      } else if (roles.has(Role.PHARMACIST)) {
        facilityType = 'PHARMACY';
      } else if (roles.has(Role.RECEPTIONIST)) {
        facilityType = 'RECEPTION';
      }
      const primaryWithLoc = g.staff.find((s) => s.governorate || s.addressAr || s.latitude != null) ?? g.staff[0];
      const fallbackLoc = inferLocationFromFacilityText(g.facilityEn, g.facilityAr);
      return {
        key: g.key,
        facilityType,
        facilityEn: g.facilityEn,
        facilityAr: g.facilityAr,
        governorate: primaryWithLoc?.governorate ?? fallbackLoc.governorate,
        city: primaryWithLoc?.city ?? fallbackLoc.city,
        district: primaryWithLoc?.district ?? null,
        addressAr: primaryWithLoc?.addressAr ?? fallbackLoc.addressAr,
        addressEn: primaryWithLoc?.addressEn ?? fallbackLoc.addressEn,
        latitude: primaryWithLoc?.latitude ?? fallbackLoc.latitude,
        longitude: primaryWithLoc?.longitude ?? fallbackLoc.longitude,
        staffCount: g.staff.length,
        staff: g.staff,
      };
    });
  }

  async updateStaffLocation(id: string, dto: UpdateLocationDto) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true, facilityEn: true, facilityAr: true } });
    if (!target || target.role === Role.PATIENT) throw new NotFoundException('STAFF_NOT_FOUND');
    const loc = this.resolveLocationFields({
      ...dto,
      facilityEn: target.facilityEn ?? undefined,
      facilityAr: target.facilityAr ?? undefined,
    });
    if (dto.applyToFacility && target.facilityEn) {
      await this.prisma.user.updateMany({
        where: { facilityEn: target.facilityEn, role: { not: Role.PATIENT } },
        data: loc,
      });
    } else {
      await this.prisma.user.update({ where: { id }, data: loc });
    }
    return this.prisma.user.findUniqueOrThrow({ where: { id }, select: SELECT });
  }

  async listAddressChangeRequests() {
    const rows = await this.prisma.addressChangeRequest.findMany({
      include: {
        doctor: {
          select: {
            id: true, fullNameAr: true, fullNameEn: true, email: true,
            facilityAr: true, facilityEn: true, specialityAr: true, specialityEn: true,
            governorate: true, city: true, district: true, addressAr: true, addressEn: true,
          },
        },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return rows;
  }

  async decideAddressChangeRequest(
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    reviewerId: string,
    note?: string,
  ) {
    const req = await this.prisma.addressChangeRequest.findUnique({
      where: { id },
      include: { doctor: { select: { id: true, facilityEn: true, fullNameAr: true, fullNameEn: true } } },
    });
    if (!req) throw new NotFoundException('ADDRESS_REQUEST_NOT_FOUND');
    if (req.status !== AddressChangeStatus.PENDING) {
      throw new BadRequestException('ADDRESS_REQUEST_ALREADY_DECIDED');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (decision === 'APPROVED') {
        const meta = getGovernorateMeta(req.newGovernorate);
        const locData = {
          governorate: normalizeGovernorate(req.newGovernorate) ?? req.newGovernorate,
          city: req.newCity || meta?.en || null,
          district: req.newDistrict || null,
          addressAr: req.newAddressAr,
          addressEn: req.newAddressEn || req.newAddressAr,
          latitude: req.newLatitude ?? meta?.lat ?? null,
          longitude: req.newLongitude ?? meta?.lng ?? null,
        };
        await tx.user.update({ where: { id: req.doctorId }, data: locData });
        if (req.doctor.facilityEn) {
          await tx.user.updateMany({
            where: {
              facilityEn: req.doctor.facilityEn,
              role: Role.RECEPTIONIST,
              specialityEn: 'CLINIC_ASSISTANT',
            },
            data: locData,
          });
        }
      }
      return tx.addressChangeRequest.update({
        where: { id },
        data: {
          status: decision === 'APPROVED' ? AddressChangeStatus.APPROVED : AddressChangeStatus.REJECTED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          reviewNote: note?.trim() || null,
        },
      });
    });

    await this.notifs
      .sendToUser(
        req.doctorId,
        NotifType.ADDRESS_CHANGE_DECIDED,
        decision === 'APPROVED' ? 'Clinic Address Change Approved' : 'Clinic Address Change Rejected',
        decision === 'APPROVED' ? 'تمت الموافقة على تغيير عنوان العيادة ✓' : 'تم رفض طلب تغيير عنوان العيادة',
        decision === 'APPROVED'
          ? `Admin approved your clinic relocation to: ${req.newAddressEn || req.newAddressAr}.`
          : `Your clinic address change request was declined${note ? `: ${note}` : '.'}`,
        decision === 'APPROVED'
          ? `وافق مدير النظام على تحديث عنوان عيادتك إلى: ${req.newAddressAr}.`
          : `رفض مدير النظام طلب تغيير عنوان العيادة${note ? `: ${note}` : '.'}`,
        { category: 'ADDRESS_CHANGE_DECIDED', requestId: id, status: decision, href: '/doctor/schedule' },
      )
      .catch(() => undefined);

    return updated;
  }

  private async ensureUniqueEmail(candidateEmail: string, rolePrefix: string, excludeEmail?: string): Promise<string> {
    let email = candidateEmail.trim().toLowerCase();
    const [rawLocal, rawDomain] = email.split('@');
    const local = rawLocal || 'staff';
    const domain = rawDomain || 'mnis.eg';

    if (excludeEmail && email === excludeEmail.toLowerCase()) {
      email = `${rolePrefix}.${local}@${domain}`;
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      if (!excludeEmail || email !== excludeEmail.toLowerCase()) {
        const exists = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (!exists) return email;
      }
      const suffix = Math.floor(100 + Math.random() * 900);
      const baseLocal = attempt === 0 && excludeEmail ? `${rolePrefix}.${local}` : local;
      email = `${baseLocal}.${suffix}@${domain}`;
    }
    return `${rolePrefix}.${local}.${Date.now()}@${domain}`;
  }

  async createFacilityBundle(dto: CreateFacilityBundleDto) {
    const primaryEmail = await this.ensureUniqueEmail(dto.primaryEmail, 'primary');
    const rolePrefix =
      dto.facilityType === 'CLINIC'
        ? 'assistant'
        : dto.facilityType === 'LAB'
          ? 'specialist'
          : dto.facilityType === 'PHARMACY'
            ? 'dispensing'
            : 'doctor';
    const rawSecondary = dto.secondaryEmail?.trim().toLowerCase() || '';
    const [pLocal, pDomain] = primaryEmail.split('@');
    const secondaryCandidate =
      rawSecondary && rawSecondary !== primaryEmail
        ? rawSecondary
        : `${rolePrefix}.${pLocal || 'staff'}@${pDomain || 'mnis.eg'}`;
    const secondaryEmail = await this.ensureUniqueEmail(secondaryCandidate, rolePrefix, primaryEmail);
    const directorEmail =
      dto.facilityType === 'LAB'
        ? await this.ensureUniqueEmail(
            `${dto.labSubType === 'RADIOLOGY' ? 'rad.director' : 'director'}.${pLocal || 'lab'}@${pDomain || 'mnis.eg'}`,
            'director',
            secondaryEmail,
          )
        : null;

    const temp1 = generateTempPassword();
    const hash1 = await argon2.hash(temp1);
    const temp2 = generateTempPassword();
    const hash2 = await argon2.hash(temp2);
    const temp3 = directorEmail ? generateTempPassword() : null;
    const hash3 = temp3 ? await argon2.hash(temp3) : null;

    const facilityEn = dto.facilityEn.trim();
    const facilityAr = dto.facilityAr.trim();
    const loc = this.resolveLocationFields({ ...dto, facilityEn, facilityAr });

    const accounts: Array<{
      user: Record<string, unknown>;
      temporaryPassword: string;
      roleLabelEn: string;
      roleLabelAr: string;
    }> = [];

    await this.prisma.$transaction(async (tx) => {
      if (dto.facilityType === 'CLINIC') {
        const doc = await tx.user.create({
          data: {
            email: primaryEmail,
            passwordHash: hash1,
            role: Role.DOCTOR,
            fullNameEn: dto.primaryNameEn.trim(),
            fullNameAr: dto.primaryNameAr.trim(),
            licenseNo: dto.licenseNo?.trim() || `EGY-DOC-${Math.floor(100000 + Math.random() * 900000)}`,
            specialityEn: dto.specialityEn?.trim() || 'General & Internal Medicine',
            specialityAr: dto.specialityAr?.trim() || 'الباطنة والطب العام',
            facilityEn,
            facilityAr,
            ...loc,
            mustChangePassword: false,
          },
          select: SELECT,
        });
        for (let d = 0; d <= 6; d++) {
          await tx.doctorSchedule.create({
            data: {
              doctorId: doc.id,
              dayOfWeek: d,
              startTime: '09:00',
              endTime: '17:00',
              slotMinutes: 20,
              isActive: true,
            },
          });
        }
        accounts.push({
          user: doc,
          temporaryPassword: temp1,
          roleLabelEn: 'Clinic Physician (Doctor)',
          roleLabelAr: 'طبيب العيادة',
        });

        if (secondaryEmail && hash2 && temp2) {
          const ast = await tx.user.create({
            data: {
              email: secondaryEmail,
              passwordHash: hash2,
              role: Role.RECEPTIONIST,
              fullNameEn: dto.secondaryNameEn?.trim() || `Assistant — ${dto.primaryNameEn.trim()}`,
              fullNameAr: dto.secondaryNameAr?.trim() || `مساعد عيادة ${dto.primaryNameAr.trim()}`,
              licenseNo: `AST:${primaryEmail}`,
              specialityEn: 'CLINIC_ASSISTANT',
              specialityAr: 'مساعد طبيب وإدارة عيادة',
              facilityEn,
              facilityAr,
              ...loc,
              mustChangePassword: false,
            },
            select: SELECT,
          });
          accounts.push({
            user: ast,
            temporaryPassword: temp2,
            roleLabelEn: 'Doctor Clinic Assistant',
            roleLabelAr: 'الموظف المساعد للطبيب',
          });
        }
      } else if (dto.facilityType === 'LAB') {
        const isRadiology = dto.labSubType === 'RADIOLOGY';
        const baseLic =
          dto.licenseNo?.trim() ||
          `${isRadiology ? 'RAD-EG' : 'LAB-EG'}-${Math.floor(1000 + Math.random() * 9000)}`;

        const labRec = await tx.user.create({
          data: {
            email: primaryEmail,
            passwordHash: hash1,
            role: Role.LAB_TECH,
            fullNameEn: dto.primaryNameEn.trim(),
            fullNameAr: dto.primaryNameAr.trim(),
            licenseNo: baseLic,
            specialityEn: isRadiology ? 'RADIOLOGY_RECEPTION' : 'LAB_RECEPTION',
            specialityAr: isRadiology ? 'استقبال وحجز مركز الأشعة' : 'استقبال وسحب عينات المعمل',
            facilityEn,
            facilityAr,
            ...loc,
            mustChangePassword: false,
          },
          select: SELECT,
        });
        accounts.push({
          user: labRec,
          temporaryPassword: temp1,
          roleLabelEn: isRadiology ? 'Radiology Receptionist' : 'Lab Receptionist & Intake Officer',
          roleLabelAr: isRadiology ? 'موظف استقبال مركز الأشعة' : 'موظف استقبال معمل التحاليل',
        });

        if (secondaryEmail && hash2 && temp2) {
          const specEnInput = dto.specialityEn?.trim();
          const radSpecEn =
            specEnInput && specEnInput.toUpperCase().startsWith('RADIOLOGY')
              ? specEnInput
              : 'RADIOLOGY_SPECIALIST';
          const labSpec = await tx.user.create({
            data: {
              email: secondaryEmail,
              passwordHash: hash2,
              role: Role.LAB_TECH,
              fullNameEn:
                dto.secondaryNameEn?.trim() ||
                `${facilityEn} ${isRadiology ? 'Radiology Specialist' : 'Specialist'}`,
              fullNameAr:
                dto.secondaryNameAr?.trim() ||
                `${isRadiology ? 'أخصائي أشعة' : 'أخصائي تحاليل'} — ${facilityAr}`,
              licenseNo: `${baseLic}-SPEC`,
              specialityEn: isRadiology ? radSpecEn : specEnInput || 'Diagnostic Lab Specialist',
              specialityAr:
                dto.specialityAr?.trim() ||
                (isRadiology ? 'أخصائي أشعة تشخيصية معتمد' : 'أخصائي تحاليل طبية معتمد'),
              facilityEn,
              facilityAr,
              ...loc,
              mustChangePassword: false,
            },
            select: SELECT,
          });
          accounts.push({
            user: labSpec,
            temporaryPassword: temp2,
            roleLabelEn: isRadiology ? 'Diagnostic Radiology Specialist' : 'Diagnostic Lab Specialist',
            roleLabelAr: isRadiology ? 'أخصائي الأشعة التشخيصية' : 'أخصائي التحاليل الطبية',
          });
        }

        if (directorEmail && hash3 && temp3) {
          const labDirector = await tx.user.create({
            data: {
              email: directorEmail,
              passwordHash: hash3,
              role: Role.LAB_TECH,
              fullNameEn: `${facilityEn} ${isRadiology ? 'Radiology Director' : 'Director & Verifier'}`,
              fullNameAr: `${isRadiology ? 'مدير مركز الأشعة' : 'مدير ومعتمد النتائج'} — ${facilityAr}`,
              licenseNo: `${baseLic}-DIR`,
              specialityEn: isRadiology ? 'RADIOLOGY_DIRECTOR' : 'Lab Director & Senior Verifier',
              specialityAr: isRadiology ? 'مدير مركز الأشعة والتقارير' : 'مدير المعمل ومعتمد النتائج النهائية',
              facilityEn,
              facilityAr,
              ...loc,
              mustChangePassword: false,
            },
            select: SELECT,
          });
          accounts.push({
            user: labDirector,
            temporaryPassword: temp3,
            roleLabelEn: isRadiology
              ? 'Radiology Center Director'
              : 'Lab Director & Senior Verifier (Dual Sign-Off)',
            roleLabelAr: isRadiology
              ? 'مدير مركز الأشعة والتقارير'
              : 'مدير المعمل ومعتمد النتائج النهائية (التوقيع المزدوج)',
          });
        }
      } else if (dto.facilityType === 'PHARMACY') {
        const baseLic = dto.licenseNo?.trim() || `PHARM-EG-${Math.floor(1000 + Math.random() * 9000)}`;
        const chiefPharm = await tx.user.create({
          data: {
            email: primaryEmail,
            passwordHash: hash1,
            role: Role.PHARMACIST,
            fullNameEn: dto.primaryNameEn.trim(),
            fullNameAr: dto.primaryNameAr.trim(),
            licenseNo: baseLic,
            specialityEn: dto.specialityEn?.trim() || 'Chief & Clinical Pharmacist',
            specialityAr: dto.specialityAr?.trim() || 'مدير الصيدلية والصيدلي المسؤول',
            facilityEn,
            facilityAr,
            ...loc,
            mustChangePassword: false,
          },
          select: SELECT,
        });
        accounts.push({
          user: chiefPharm,
          temporaryPassword: temp1,
          roleLabelEn: 'Chief Pharmacist',
          roleLabelAr: 'مدير الصيدلية / الصيدلي المسؤول',
        });

        if (secondaryEmail && hash2 && temp2) {
          const dispPharm = await tx.user.create({
            data: {
              email: secondaryEmail,
              passwordHash: hash2,
              role: Role.PHARMACIST,
              fullNameEn: dto.secondaryNameEn?.trim() || `Dispensing Pharmacist — ${facilityEn}`,
              fullNameAr: dto.secondaryNameAr?.trim() || `صيدلي الصرف — ${facilityAr}`,
              licenseNo: `${baseLic}-DISP`,
              specialityEn: 'Dispensing Pharmacist',
              specialityAr: 'صيدلي صرف الروشتات وحصص المزمن',
              facilityEn,
              facilityAr,
              ...loc,
              mustChangePassword: false,
            },
            select: SELECT,
          });
          accounts.push({
            user: dispPharm,
            temporaryPassword: temp2,
            roleLabelEn: 'Dispensing Pharmacist',
            roleLabelAr: 'صيدلي الصرف',
          });
        }
      } else {
        const baseLic = dto.licenseNo?.trim() || `HOSP-EG-${Math.floor(1000 + Math.random() * 9000)}`;
        const hospOfficer = await tx.user.create({
          data: {
            email: primaryEmail,
            passwordHash: hash1,
            role: Role.HOSPITAL_STAFF,
            fullNameEn: dto.primaryNameEn.trim(),
            fullNameAr: dto.primaryNameAr.trim(),
            licenseNo: baseLic,
            specialityEn: 'Emergency & Inpatient Operations',
            specialityAr: 'عمليات الطوارئ والتنويم بالمستشفى',
            facilityEn,
            facilityAr,
            ...loc,
            mustChangePassword: false,
          },
          select: SELECT,
        });
        accounts.push({
          user: hospOfficer,
          temporaryPassword: temp1,
          roleLabelEn: 'Hospital & ER Officer',
          roleLabelAr: 'مسؤول الطوارئ وعمليات المستشفى',
        });

        if (secondaryEmail && hash2 && temp2) {
          const hospDoc = await tx.user.create({
            data: {
              email: secondaryEmail,
              passwordHash: hash2,
              role: Role.DOCTOR,
              fullNameEn: dto.secondaryNameEn?.trim() || `Specialist — ${facilityEn}`,
              fullNameAr: dto.secondaryNameAr?.trim() || `طبيب — ${facilityAr}`,
              licenseNo: `EGY-DOC-${Math.floor(100000 + Math.random() * 900000)}`,
              specialityEn: dto.specialityEn?.trim() || 'Emergency & Critical Care',
              specialityAr: dto.specialityAr?.trim() || 'طب الطوارئ والرعاية الحرجة',
              facilityEn,
              facilityAr,
              ...loc,
              mustChangePassword: false,
            },
            select: SELECT,
          });
          for (let d = 0; d <= 6; d++) {
            await tx.doctorSchedule.create({
              data: {
                doctorId: hospDoc.id,
                dayOfWeek: d,
                startTime: '09:00',
                endTime: '17:00',
                slotMinutes: 20,
                isActive: true,
              },
            });
          }
          accounts.push({
            user: hospDoc,
            temporaryPassword: temp2,
            roleLabelEn: 'Hospital Specialist Physician',
            roleLabelAr: 'طبيب أخصائي بالمستشفى',
          });
        }

        const codeSuffix = Math.floor(1000 + Math.random() * 9000);
        await tx.bed.createMany({
          data: [
            {
              wardEn: `${facilityEn} — ICU & Acute Care`,
              wardAr: `${facilityAr} — الرعاية المركزة والحرجة`,
              bedNumber: `H-${codeSuffix}-1`,
              status: 'AVAILABLE',
            },
            {
              wardEn: `${facilityEn} — General Inpatient`,
              wardAr: `${facilityAr} — التنويم الداخلي العام`,
              bedNumber: `H-${codeSuffix}-2`,
              status: 'AVAILABLE',
            },
          ],
        });
      }
    });

    return {
      facilityType: dto.facilityType,
      facilityEn,
      facilityAr,
      accounts,
    };
  }
}

@ApiTags('admin') @ApiBearerAuth() @Audit('USER')
@Roles(Role.ADMIN)
@Controller('admin/users')
export class AdminController {
  constructor(private svc: AdminService) {}
  @Get() list() { return this.svc.list(); }
  @Get('facilities')
  @Roles(Role.ADMIN, Role.EXECUTIVE, Role.DOCTOR, Role.LAB_TECH, Role.HOSPITAL_STAFF, Role.PHARMACIST, Role.RECEPTIONIST)
  listFacilities() { return this.svc.listFacilities(); }
  @Post('facilities')
  @Roles(Role.ADMIN)
  createFacilityBundle(@Body() dto: CreateFacilityBundleDto) { return this.svc.createFacilityBundle(dto); }
  @Get('address-requests')
  @Roles(Role.ADMIN)
  listAddressRequests() { return this.svc.listAddressChangeRequests(); }
  @Post('address-requests/:id/approve')
  @Roles(Role.ADMIN)
  approveAddress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewAddressChangeDto, @CurrentUser() u: AuthUser) {
    return this.svc.decideAddressChangeRequest(id, 'APPROVED', u.id, dto?.note);
  }
  @Post('address-requests/:id/reject')
  @Roles(Role.ADMIN)
  rejectAddress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewAddressChangeDto, @CurrentUser() u: AuthUser) {
    return this.svc.decideAddressChangeRequest(id, 'REJECTED', u.id, dto?.note);
  }
  @Patch(':id/location')
  @Roles(Role.ADMIN)
  updateLocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.svc.updateStaffLocation(id, dto);
  }
  @Get('audit-logs') auditLogs() { return this.svc.getAuditLogs(); }
  @Get('security-posture') securityPosture() { return this.svc.getSecurityPosture(); }
  @Post() @Roles(Role.ADMIN) create(@Body() dto: CreateStaffDto) { return this.svc.create(dto); }
  @Patch(':id/active') @Roles(Role.ADMIN) setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto, @CurrentUser() u: AuthUser) { return this.svc.setActive(id, dto.isActive, u.id); }
  @Post(':id/reset-password') @Roles(Role.ADMIN) reset(@Param('id', ParseUUIDPipe) id: string) { return this.svc.resetPassword(id); }
  @Delete(':id') @Roles(Role.ADMIN) deleteStaff(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.svc.deleteStaff(id, u.id); }
}

@Module({ imports: [NotificationsModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
