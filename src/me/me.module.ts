import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  ParseUUIDPipe,
  Body,
  Injectable,
  Module,
  NotFoundException,
  BadRequestException,
  ConflictException
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, AppointmentType, NfcCardStatus, NotifType } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsString, IsUUID, IsOptional, IsInt, Min, Max, IsDateString, Matches, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoService, CryptoModule } from '../common/crypto.service';
import { maskPhone } from '../common/phone.util';
import { parseMedicationSchedule } from '../common/medication-schedule.util';
import { Audit, CurrentUser, AuthUser, Roles } from '../common/decorators';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

// --- DTOs ---
export class CreateAppointmentDto {
  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @IsOptional()
  @IsUUID()
  labId?: string;

  @IsEnum(AppointmentType)
  type: AppointmentType;

  @IsDateString()
  preferredDate: string;

  @IsOptional()
  @IsString()
  preferredTime?: string;

  @IsString()
  reason: string;

  @IsOptional()
  @IsString()
  testPanel?: string;
}

export class CreateRenewalDto {
  @IsUUID()
  prescriptionId: string;
}

export class UploadDocumentDto {
  @IsString()
  label: string;

  @IsString()
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(5000000)
  fileSizeBytes: number;

  @IsString()
  fileBase64: string;
}

export class UpdateMyProfileDto {
  @IsOptional()
  @IsBoolean()
  organDonor?: boolean;
}

export class UpdateMedicationReminderDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { each: true })
  scheduleTimes?: string[];
}

// --- Service ---
@Injectable()
export class MeService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private notifs: NotificationsService,
  ) {}

  private async getPatientId(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { patientId: true } });
    if (!user?.patientId) throw new NotFoundException('NO_PATIENT_RECORD');
    return user.patientId;
  }

  async getProfile(userId: string) {
    const patientId = await this.getPatientId(userId);
    const p = await this.prisma.patient.findUnique({
      where: { id: patientId }
    });
    if (!p) throw new NotFoundException('NO_PATIENT_RECORD');
    let nationalId = '';
    try {
      nationalId = this.crypto.decrypt(p.nationalIdEnc);
    } catch {
      nationalId = '';
    }
    return {
      id: p.id,
      mti: p.mti,
      nationalId,
      fullNameEn: p.fullNameEn,
      fullNameAr: p.fullNameAr,
      sex: p.sex,
      birthDate: p.birthDate,
      bloodType: p.bloodType,
      phone: p.phone,
      phoneMasked: maskPhone(p.phone),
      phoneVerifiedAt: p.phoneVerifiedAt,
      governorate: p.governorate,
      city: p.city,
      district: p.district,
      addressEn: p.addressEn || [p.district, p.governorate].filter(Boolean).join(', '),
      addressAr: p.addressAr || [p.district, p.governorate].filter(Boolean).join('، '),
      photoUrl: p.photoUrl,
      insuranceActive: p.insuranceActive,
      organDonor: p.organDonor,
      chronicConditions: p.chronicConditions,
      allergies: p.allergies
    };
  }

  private async getUsersMap(ids: Array<string | null | undefined>) {
    const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
    if (unique.length === 0) return new Map<string, any>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: {
        id: true, fullNameEn: true, fullNameAr: true,
        specialityEn: true, specialityAr: true, facilityEn: true, facilityAr: true,
        licenseNo: true, role: true,
      },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  async getPrescriptions(userId: string) {
    const patientId = await this.getPatientId(userId);
    const rows = await this.prisma.prescription.findMany({
      where: { patientId, status: { not: 'DRAFT' } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    const map = await this.getUsersMap(rows.map((r) => r.physicianId));
    return rows.map((r) => ({ ...r, physician: map.get(r.physicianId) ?? null }));
  }

  async getLabResults(userId: string) {
    const patientId = await this.getPatientId(userId);
    const rows = await this.prisma.labSample.findMany({
      where: { patientId },
      include: { results: true },
      orderBy: { collectedAt: 'desc' },
    });
    const map = await this.getUsersMap(rows.flatMap((s) => [s.orderedById, s.verifiedById]));
    return rows.map((s) => ({
      ...s,
      results: s.status === 'VERIFIED' ? s.results : [],
      orderedBy: map.get(s.orderedById) ?? null,
      verifiedBy: s.verifiedById ? (map.get(s.verifiedById) ?? null) : null,
    }));
  }

  async getVisits(userId: string) {
    const patientId = await this.getPatientId(userId);
    const rows = await this.prisma.visit.findMany({
      where: { patientId },
      orderBy: { arrivedAt: 'desc' },
      take: 50,
    });
    const map = await this.getUsersMap(rows.map((v) => v.doctorId));
    return rows.map((v) => ({ ...v, doctor: v.doctorId ? (map.get(v.doctorId) ?? null) : null }));
  }

  async getAppointments(userId: string) {
    const patientId = await this.getPatientId(userId);
    const rows = await this.prisma.appointment.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });
    const map = await this.getUsersMap(rows.map((a) => a.doctorId));
    return rows.map((a) => ({ ...a, doctor: a.doctorId ? (map.get(a.doctorId) ?? null) : null }));
  }

  async requestAppointment(userId: string, dto: CreateAppointmentDto) {
    const patientId = await this.getPatientId(userId);
    const pDate = new Date(dto.preferredDate);
    if (dto.preferredTime && /^\d{2}:\d{2}$/.test(dto.preferredTime.trim())) {
      const [hh, mm] = dto.preferredTime.trim().split(':').map(Number);
      pDate.setHours(hh, mm, 0, 0);
    }
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (pDate < startOfToday) throw new BadRequestException('DATE_IN_PAST');

    const openCount = await this.prisma.appointment.count({
      where: { patientId, status: 'REQUESTED' },
    });
    if (openCount >= 10) throw new BadRequestException('TOO_MANY_OPEN_REQUESTS');

    let providerId: string | undefined;
    if (dto.type === 'CLINIC') {
      if (!dto.doctorId) throw new BadRequestException('Please select a clinic / physician');
      const doctor = await this.prisma.user.findFirst({ where: { id: dto.doctorId, role: 'DOCTOR', isActive: true } });
      if (!doctor) throw new NotFoundException('Doctor not found or inactive');
      providerId = doctor.id;
    } else {
      const targetLabId = dto.labId || dto.doctorId;
      if (!targetLabId) throw new BadRequestException('Please select a laboratory');
      if (!dto.testPanel?.trim()) throw new BadRequestException('Please specify the required lab test panel');
      const lab = await this.prisma.user.findFirst({ where: { id: targetLabId, role: 'LAB_TECH', isActive: true } });
      if (!lab) throw new NotFoundException('Laboratory not found or inactive');
      providerId = lab.id;
    }

    const created = await this.prisma.appointment.create({
      data: {
        patientId,
        doctorId: providerId,
        type: dto.type,
        preferredDate: pDate,
        reason: dto.reason,
        testPanel: dto.testPanel?.trim() || null,
        status: 'REQUESTED',
      },
    });

    // Notify target provider & clinic assistant / lab team in real time
    const [citizen, providerUser] = await Promise.all([
      this.prisma.patient.findUnique({ where: { id: patientId }, select: { fullNameAr: true, fullNameEn: true, mti: true } }),
      providerId
        ? this.prisma.user.findUnique({
            where: { id: providerId },
            select: { id: true, role: true, facilityEn: true, specialityEn: true, licenseNo: true },
          })
        : Promise.resolve(null),
    ]);
    if (providerUser) {
      const targetUserIds = new Set<string>([providerUser.id]);
      if (dto.type === 'CLINIC' && providerUser.facilityEn) {
        const assistants = await this.prisma.user.findMany({
          where: { role: Role.RECEPTIONIST, specialityEn: 'CLINIC_ASSISTANT', facilityEn: providerUser.facilityEn, isActive: true },
          select: { id: true },
        });
        assistants.forEach((a) => targetUserIds.add(a.id));
      } else if (dto.type === 'LAB' && providerUser.facilityEn) {
        const labTeam = await this.prisma.user.findMany({
          where: { role: Role.LAB_TECH, facilityEn: providerUser.facilityEn, isActive: true },
          select: { id: true },
        });
        labTeam.forEach((l) => targetUserIds.add(l.id));
      }
      const isRad =
        dto.type === 'LAB' &&
        (providerUser.specialityEn?.toUpperCase().startsWith('RADIOLOGY') ||
          providerUser.licenseNo?.toUpperCase().startsWith('RAD-'));
      const href = dto.type === 'CLINIC' ? '/doctor/appointments' : '/lab/appointments';
      const titleAr =
        dto.type === 'CLINIC'
          ? `طلب حجز عيادة جديد — ${citizen?.fullNameAr ?? ''}`
          : isRad
            ? `طلب حجز أشعة جديد — ${citizen?.fullNameAr ?? ''}`
            : `طلب حجز معمل تحاليل جديد — ${citizen?.fullNameAr ?? ''}`;
      const titleEn =
        dto.type === 'CLINIC'
          ? `New Clinic Booking Request — ${citizen?.fullNameEn ?? ''}`
          : isRad
            ? `New Radiology Booking Request — ${citizen?.fullNameEn ?? ''}`
            : `New Lab Booking Request — ${citizen?.fullNameEn ?? ''}`;
      const bodyAr = `المواطن (${citizen?.mti ?? ''}) • ${dto.testPanel ? `${dto.testPanel} — ` : ''}${dto.reason}`;
      const bodyEn = `Citizen (${citizen?.mti ?? ''}) • ${dto.testPanel ? `${dto.testPanel} — ` : ''}${dto.reason}`;
      void this.notifs
        .notifyManyUsers(Array.from(targetUserIds), NotifType.NEW_APPOINTMENT_REQUEST, titleEn, titleAr, bodyEn, bodyAr, {
          category: 'APPOINTMENT_REQUEST',
          appointmentId: created.id,
          href,
          severity: 'INFO',
        })
        .catch(() => undefined);
    }

    const map = await this.getUsersMap([created.doctorId]);
    return { ...created, doctor: created.doctorId ? (map.get(created.doctorId) ?? null) : null };
  }

  async cancelAppointment(userId: string, appointmentId: string) {
    const patientId = await this.getPatientId(userId);
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appt || appt.patientId !== patientId) throw new NotFoundException('Appointment not found');
    if (appt.status !== 'REQUESTED' && appt.status !== 'CONFIRMED') {
      throw new BadRequestException('Can only cancel REQUESTED or CONFIRMED appointments');
    }

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: 'CANCELLED' }
    });
  }

  async getRenewals(userId: string) {
    const patientId = await this.getPatientId(userId);
    return this.prisma.renewalRequest.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async requestRenewal(userId: string, dto: CreateRenewalDto) {
    const patientId = await this.getPatientId(userId);
    const rx = await this.prisma.prescription.findUnique({ where: { id: dto.prescriptionId } });
    if (!rx || rx.patientId !== patientId) throw new NotFoundException('Prescription not found');
    if (rx.status !== 'DISPENSED') throw new BadRequestException('Can only renew dispensed prescriptions');

    const existing = await this.prisma.renewalRequest.findFirst({
      where: { patientId, prescriptionId: dto.prescriptionId, status: 'PENDING' }
    });
    if (existing) throw new ConflictException('Pending renewal already exists for this prescription');

    const renewal = await this.prisma.renewalRequest.create({
      data: {
        patientId,
        prescriptionId: dto.prescriptionId,
        status: 'PENDING'
      }
    });

    const citizen = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { fullNameAr: true, fullNameEn: true, mti: true },
    });
    if (rx.physicianId) {
      void this.notifs
        .sendToUser(
          rx.physicianId,
          NotifType.NEW_RENEWAL_REQUEST,
          `Rx Renewal Request (#${rx.code})`,
          `طلب تجديد روشتة مزمنة (#${rx.code})`,
          `${citizen?.fullNameEn ?? 'Citizen'} (${citizen?.mti ?? ''}) requested a renewal for prescription #${rx.code}.`,
          `طلب المواطن ${citizen?.fullNameAr ?? ''} (${citizen?.mti ?? ''}) تجديد الروشتة رقم #${rx.code}.`,
          { category: 'RENEWAL_REQUEST', renewalId: renewal.id, prescriptionId: rx.id, href: '/doctor/e-prescriptions' },
        )
        .catch(() => undefined);
    }
    return renewal;
  }

  async generateShareToken(userId: string) {
    const patientId = await this.getPatientId(userId);
    // 10-character uppercase hex code matching RedeemDto @Length(10, 10)
    const rawToken = randomBytes(5).toString('hex').toUpperCase();
    const tokenHash = this.crypto.sha256(rawToken);
    
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.shareToken.create({
      data: { patientId, tokenHash, expiresAt }
    });

    return { code: rawToken, token: rawToken, expiresAt };
  }

  async getDocuments(userId: string) {
    const patientId = await this.getPatientId(userId);
    return this.prisma.document.findMany({
      where: { patientId },
      select: { id: true, label: true, mimeType: true, fileSizeBytes: true, status: true, createdAt: true, reviewedAt: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getDocumentFile(userId: string, docId: string) {
    const patientId = await this.getPatientId(userId);
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc || doc.patientId !== patientId) throw new NotFoundException('Document not found');
    return {
      id: doc.id,
      label: doc.label,
      mimeType: doc.mimeType,
      fileSizeBytes: doc.fileSizeBytes,
      fileBase64: doc.fileBase64,
    };
  }

  async uploadDocument(userId: string, dto: UploadDocumentDto) {
    const patientId = await this.getPatientId(userId);
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(dto.mimeType)) throw new BadRequestException('Invalid file type');

    const docCount = await this.prisma.document.count({ where: { patientId } });
    if (docCount >= 50) throw new BadRequestException('DOCUMENT_LIMIT_REACHED');

    const cleanedB64 = dto.fileBase64.replace(/^data:[^;]+;base64,/, '');
    const actualBytes = Buffer.from(cleanedB64, 'base64').length;
    if (actualBytes < 1 || actualBytes > 5_000_000) {
      throw new BadRequestException('FILE_SIZE_INVALID');
    }

    const doc = await this.prisma.document.create({
      data: {
        patientId,
        label: dto.label,
        mimeType: dto.mimeType,
        fileSizeBytes: actualBytes,
        fileBase64: dto.fileBase64,
        status: 'PENDING_REVIEW'
      }
    });

    const [latestRx, latestVisit, citizen] = await Promise.all([
      this.prisma.prescription.findFirst({ where: { patientId }, orderBy: { createdAt: 'desc' }, select: { physicianId: true } }),
      this.prisma.visit.findFirst({ where: { patientId, doctorId: { not: null } }, orderBy: { arrivedAt: 'desc' }, select: { doctorId: true } }),
      this.prisma.patient.findUnique({ where: { id: patientId }, select: { fullNameAr: true, fullNameEn: true, mti: true } }),
    ]);
    const targetDoctorId = latestVisit?.doctorId ?? latestRx?.physicianId;
    if (targetDoctorId) {
      void this.notifs
        .sendToUser(
          targetDoctorId,
          NotifType.GENERAL,
          `New Medical Document Uploaded — ${citizen?.fullNameEn ?? ''}`,
          `مستند طبي جديد من المريض — ${citizen?.fullNameAr ?? ''}`,
          `${citizen?.fullNameEn ?? 'Citizen'} uploaded "${dto.label}" for clinical review.`,
          `قام المواطن ${citizen?.fullNameAr ?? ''} (${citizen?.mti ?? ''}) برفع مستند "${dto.label}" للمراجعة الطبية.`,
          { category: 'DOCUMENT_UPLOADED', documentId: doc.id, href: `/doctor/consultation?patientId=${patientId}` },
        )
        .catch(() => undefined);
    }

    return doc;
  }

  async getActiveCard(userId: string) {
    const patientId = await this.getPatientId(userId);
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId }
    });
    if (!patient) throw new NotFoundException('Patient not found');

    let card = await this.prisma.nfcCard.findFirst({
      where: { patientId, status: NfcCardStatus.ACTIVE },
      select: { id: true, printedAt: true, status: true }
    });

    if (!card) {
      const rawToken = randomBytes(32).toString('hex').toUpperCase();
      const tokenHash = this.crypto.sha256(rawToken);
      card = await this.prisma.nfcCard.create({
        data: {
          patientId,
          tokenHash,
          status: NfcCardStatus.ACTIVE,
          printedById: userId,
        },
        select: { id: true, printedAt: true, status: true }
      });
    }

    return {
      id: card.id,
      printedAt: card.printedAt,
      status: card.status,
      mti: patient.mti,
      fullNameEn: patient.fullNameEn,
      fullNameAr: patient.fullNameAr,
      sex: patient.sex,
      birthDate: patient.birthDate,
      bloodType: patient.bloodType,
      allergies: patient.allergies,
      chronicConditions: patient.chronicConditions,
      organDonor: patient.organDonor,
    };
  }

  async updateProfile(userId: string, dto: UpdateMyProfileDto) {
    const patientId = await this.getPatientId(userId);
    if (typeof dto.organDonor === 'boolean') {
      await this.prisma.patient.update({
        where: { id: patientId },
        data: { organDonor: dto.organDonor },
      });
    }
    return this.getProfile(userId);
  }

  async getSummaryHub(userId: string) {
    const patientId = await this.getPatientId(userId);
    const [rxIds, sampleIds, refIds, cardIds, docIds] = await Promise.all([
      this.prisma.prescription.findMany({ where: { patientId }, select: { id: true } }),
      this.prisma.labSample.findMany({ where: { patientId }, select: { id: true } }),
      this.prisma.referral.findMany({ where: { patientId }, select: { id: true } }),
      this.prisma.nfcCard.findMany({ where: { patientId }, select: { id: true } }),
      this.prisma.document.findMany({ where: { patientId }, select: { id: true } }),
    ]);
    const ownedResourceIds = [
      patientId,
      ...rxIds.map((x) => x.id),
      ...sampleIds.map((x) => x.id),
      ...refIds.map((x) => x.id),
      ...cardIds.map((x) => x.id),
      ...docIds.map((x) => x.id),
    ];

    const [referrals, radiology, chronicAllowances, recentAudits, activeVisit, activeBed, orCases] = await Promise.all([
      this.prisma.referral.findMany({
        where: { patientId },
        include: {
          sender: { select: { fullNameEn: true, fullNameAr: true, specialityEn: true, specialityAr: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.radiologyUpload.findMany({
        where: { patientId },
        select: { id: true, titleEn: true, titleAr: true, mimeType: true, fileSizeBytes: true, notes: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.chronicAllowance.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        where: {
          resourceType: { in: ['PATIENT', 'PRESCRIPTION', 'LAB_SAMPLE', 'REFERRAL', 'NFC_CARD', 'BREAK_GLASS_NFC', 'SHARED_RECORD'] },
          resourceId: { in: ownedResourceIds },
          statusCode: { lt: 400 },
          OR: [{ userId: null }, { userId: { not: userId } }],
        },
        include: {
          user: { select: { fullNameEn: true, fullNameAr: true, role: true, facilityEn: true, facilityAr: true } },
        },
        orderBy: { at: 'desc' },
        take: 10,
      }),
      this.prisma.visit.findFirst({
        where: {
          patientId,
          status: { in: ['WAITING', 'IN_CONSULTATION'] },
        },
        orderBy: { arrivedAt: 'desc' },
      }),
      this.prisma.bed.findFirst({
        where: { patientId, status: 'OCCUPIED' },
      }),
      this.prisma.orCase.findMany({
        where: { patientId },
        orderBy: { scheduledStart: 'desc' },
        take: 5,
      }),
    ]);

    const surgeonMap = await this.getUsersMap(orCases.map((c) => c.surgeonId));

    let activeQueueTicket: Record<string, unknown> | null = null;
    if (activeVisit) {
      const aheadCount =
        activeVisit.status === 'WAITING'
          ? await this.prisma.visit.count({
              where: {
                status: 'WAITING',
                ...(activeVisit.doctorId ? { doctorId: activeVisit.doctorId } : {}),
                ...(activeVisit.isEmergency
                  ? { isEmergency: true, arrivedAt: { lt: activeVisit.arrivedAt } }
                  : {
                      OR: [
                        { isEmergency: true },
                        { isEmergency: false, arrivedAt: { lt: activeVisit.arrivedAt } },
                      ],
                    }),
              },
            })
          : 0;
      const docMap = await this.getUsersMap([activeVisit.doctorId]);
      const doc = activeVisit.doctorId ? docMap.get(activeVisit.doctorId) : null;
      activeQueueTicket = {
        id: activeVisit.id,
        ticketNo: activeVisit.ticketNo,
        status: activeVisit.status,
        isEmergency: activeVisit.isEmergency,
        reasonEn: activeVisit.reasonEn,
        reasonAr: activeVisit.reasonAr,
        arrivedAt: activeVisit.arrivedAt,
        calledAt: activeVisit.calledAt,
        aheadCount,
        doctorNameEn: doc?.fullNameEn ?? 'Outpatient Clinic Physician',
        doctorNameAr: doc?.fullNameAr ?? 'طبيب العيادة الخارجية المناوب',
        specialityEn: doc?.specialityEn ?? 'General Medicine',
        specialityAr: doc?.specialityAr ?? 'الطب العام والطوارئ',
        facilityEn: doc?.facilityEn ?? 'Cairo University Teaching Hospital',
        facilityAr: doc?.facilityAr ?? 'مستشفى قصر العيني التعليمي',
      };
    }

    return {
      activeQueueTicket,
      activeInpatientBed: activeBed
        ? {
            id: activeBed.id,
            bedNumber: activeBed.bedNumber,
            wardEn: activeBed.wardEn,
            wardAr: activeBed.wardAr,
            admittedAt: activeBed.admittedAt,
          }
        : null,
      surgeries: orCases.map((c) => {
        const surgeon = surgeonMap.get(c.surgeonId);
        return {
          id: c.id,
          procedureEn: c.procedureEn,
          procedureAr: c.procedureAr,
          theaterNo: c.theaterNo ?? 'OR-01',
          status: c.status,
          scheduledStart: c.scheduledStart,
          anaesthesiaEn: c.anaesthesiaEn ?? 'General Anaesthesia',
          anaesthesiaAr: c.anaesthesiaAr ?? 'تخدير كلي',
          surgeonNameEn: surgeon?.fullNameEn ?? 'Consultant Surgeon',
          surgeonNameAr: surgeon?.fullNameAr ?? 'استشاري الجراحة العامة',
        };
      }),
      referrals: referrals.map((r) => ({
        ...r,
        targetFacility: r.departmentAr || r.departmentEn || r.testPanel || r.medicationAr || r.target,
        targetType: r.target,
        reason: r.reasonAr || r.reasonEn,
      })),
      radiology: radiology.map((r) => ({
        ...r,
        modality: r.titleEn.toUpperCase().includes('CT')
          ? 'CT'
          : r.titleEn.toUpperCase().includes('MRI')
          ? 'MRI'
          : 'X-Ray',
        bodyPart: r.titleAr || r.titleEn,
        findings: r.notes ?? '',
        findingsEn: r.notes ?? '',
        findingsAr: r.notes ?? '',
      })),
      chronicAllowances: chronicAllowances.map((a) => ({
        id: a.id,
        drugName: a.nameAr || a.nameEn,
        dosage: `${a.monthlyLimit} عبوة شهرياً`,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        monthlyLimit: a.monthlyLimit,
        dispensedThisMonth: a.consumed,
        consumed: a.consumed,
        remaining: Math.max(0, a.monthlyLimit - a.consumed),
        resetAt: a.resetAt,
      })),
      accessLogs: recentAudits.map((a) => ({
        id: a.id,
        role: a.role ?? a.user?.role ?? 'DOCTOR',
        actorRole: a.role ?? a.user?.role ?? 'DOCTOR',
        actorNameAr: a.user?.fullNameAr
          ? `${a.user.fullNameAr}${a.user.facilityAr ? ' — ' + a.user.facilityAr : ''}`
          : a.resourceType === 'BREAK_GLASS_NFC'
            ? 'بروتوكول طوارئ سريع (Break-Glass NFC)'
            : 'النظام المركزي الموحد — وزارة الصحة',
        actorNameEn: a.user?.fullNameEn
          ? `${a.user.fullNameEn}${a.user.facilityEn ? ' — ' + a.user.facilityEn : ''}`
          : a.resourceType === 'BREAK_GLASS_NFC'
            ? 'Emergency Break-Glass NFC Protocol'
            : 'Unified Central System — MoHP',
        action: `${a.method} ${a.resourceType ?? 'RECORD'}`,
        resourceType: a.resourceType ?? 'PATIENT',
        method: a.method,
        createdAt: a.at,
        ip: a.ip ?? '127.0.0.1',
      })),
    };
  }

  async getMedicationReminders(userId: string) {
    const patientId = await this.getPatientId(userId);
    // Backfill reminder schedules for any already-dispensed prescriptions missing reminders
    const dispensedRxs = await this.prisma.prescription.findMany({
      where: { patientId, status: 'DISPENSED' },
      include: { items: true },
      orderBy: { dispensedAt: 'desc' },
      take: 30,
    });
    for (const rx of dispensedRxs) {
      const baseDate = rx.dispensedAt ?? rx.createdAt;
      for (const item of rx.items) {
        const parsed = parseMedicationSchedule(item.frequencyEn, item.frequencyAr, item.durationDays, baseDate);
        await this.prisma.medicationReminder.upsert({
          where: { prescriptionItemId: item.id },
          create: {
            patientId,
            prescriptionId: rx.id,
            prescriptionItemId: item.id,
            drugNameEn: item.nameEn,
            drugNameAr: item.nameAr,
            dose: item.dose,
            frequencyEn: item.frequencyEn,
            frequencyAr: item.frequencyAr,
            timesPerDay: parsed.timesPerDay,
            intervalHours: parsed.intervalHours,
            scheduleTimes: parsed.scheduleTimes,
            durationDays: item.durationDays,
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            isActive: parsed.endsAt > new Date(),
          },
          update: {},
        });
      }
    }

    return this.prisma.medicationReminder.findMany({
      where: { patientId },
      orderBy: [{ isActive: 'desc' }, { endsAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async updateMedicationReminder(userId: string, reminderId: string, dto: UpdateMedicationReminderDto) {
    const patientId = await this.getPatientId(userId);
    const existing = await this.prisma.medicationReminder.findUnique({ where: { id: reminderId } });
    if (!existing || existing.patientId !== patientId) {
      throw new NotFoundException('REMINDER_NOT_FOUND');
    }
    return this.prisma.medicationReminder.update({
      where: { id: reminderId },
      data: {
        ...(typeof dto.isActive === 'boolean' ? { isActive: dto.isActive } : {}),
        ...(dto.scheduleTimes
          ? {
              scheduleTimes: dto.scheduleTimes,
              timesPerDay: dto.scheduleTimes.length,
              intervalHours: Math.max(1, Math.round(24 / dto.scheduleTimes.length)),
            }
          : {}),
      },
    });
  }

  async markDoseTaken(userId: string, reminderId: string) {
    const patientId = await this.getPatientId(userId);
    const existing = await this.prisma.medicationReminder.findUnique({ where: { id: reminderId } });
    if (!existing || existing.patientId !== patientId) {
      throw new NotFoundException('REMINDER_NOT_FOUND');
    }
    return this.prisma.medicationReminder.update({
      where: { id: reminderId },
      data: {
        lastTakenAt: new Date(),
        dosesTakenCount: { increment: 1 },
      },
    });
  }
}

// --- Controller ---
@ApiTags('me')
@ApiBearerAuth()
@Audit('ME_CITIZEN')
@Roles(Role.PATIENT)
@Controller('me')
export class MeController {
  constructor(private svc: MeService) {}

  @Get('profile')
  getProfile(@CurrentUser() user: AuthUser) { return this.svc.getProfile(user.id); }

  @Patch('profile')
  updateProfile(@Body() dto: UpdateMyProfileDto, @CurrentUser() user: AuthUser) {
    return this.svc.updateProfile(user.id, dto);
  }

  @Get('prescriptions')
  getPrescriptions(@CurrentUser() user: AuthUser) { return this.svc.getPrescriptions(user.id); }

  @Get('lab-results')
  getLabResults(@CurrentUser() user: AuthUser) { return this.svc.getLabResults(user.id); }

  @Get('visits')
  getVisits(@CurrentUser() user: AuthUser) { return this.svc.getVisits(user.id); }

  @Get('appointments')
  getAppointments(@CurrentUser() user: AuthUser) { return this.svc.getAppointments(user.id); }

  @Post('appointments')
  requestAppointment(@Body() dto: CreateAppointmentDto, @CurrentUser() user: AuthUser) { 
    return this.svc.requestAppointment(user.id, dto); 
  }

  @Delete('appointments/:id')
  cancelAppointment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) { 
    return this.svc.cancelAppointment(user.id, id); 
  }

  @Get('renewals')
  getRenewals(@CurrentUser() user: AuthUser) { return this.svc.getRenewals(user.id); }

  @Post('renewals')
  requestRenewal(@Body() dto: CreateRenewalDto, @CurrentUser() user: AuthUser) { 
    return this.svc.requestRenewal(user.id, dto); 
  }

  @Post('share-token')
  generateShareToken(@CurrentUser() user: AuthUser) { return this.svc.generateShareToken(user.id); }

  @Get('documents')
  getDocuments(@CurrentUser() user: AuthUser) { return this.svc.getDocuments(user.id); }

  @Get('documents/:id')
  getDocumentFile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.getDocumentFile(user.id, id);
  }

  @Post('documents')
  uploadDocument(@Body() dto: UploadDocumentDto, @CurrentUser() user: AuthUser) { 
    return this.svc.uploadDocument(user.id, dto); 
  }

  @Get('card')
  getActiveCard(@CurrentUser() user: AuthUser) { return this.svc.getActiveCard(user.id); }

  @Get('summary-hub')
  getSummaryHub(@CurrentUser() user: AuthUser) { return this.svc.getSummaryHub(user.id); }

  @Get('medication-reminders')
  getMedicationReminders(@CurrentUser() user: AuthUser) {
    return this.svc.getMedicationReminders(user.id);
  }

  @Patch('medication-reminders/:id')
  updateMedicationReminder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMedicationReminderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateMedicationReminder(user.id, id, dto);
  }

  @Post('medication-reminders/:id/taken')
  markDoseTaken(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.markDoseTaken(user.id, id);
  }
}

// --- Module ---
@Module({
  imports: [PrismaModule, CryptoModule, NotificationsModule],
  controllers: [MeController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
