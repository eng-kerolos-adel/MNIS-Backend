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
import { NotifType, Role, VisitStatus, AppointmentStatus, ConditionFlagStatus, RenewalStatus, RxStatus, SampleStatus, ErStatus, ReferralStatus, OrCaseStatus } from '@prisma/client';
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
      take: 30,
    });

    const mappedPersisted: PortalNotificationItem[] = persisted.map((n) => ({
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

    if (user.role === Role.PATIENT) {
      return mappedPersisted;
    }

    const operational = await this.buildStaffOperationalNotifications(user);
    return [...mappedPersisted, ...operational];
  }

  private async buildStaffOperationalNotifications(user: AuthUser): Promise<PortalNotificationItem[]> {
    const now = new Date();
    const staff = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { facilityEn: true, specialityEn: true, role: true },
    });
    const spec = (staff?.specialityEn ?? '').toUpperCase();
    const facilityEn = staff?.facilityEn?.trim() || null;
    const isAssistant = spec === 'CLINIC_ASSISTANT';
    const isRadiology = spec.startsWith('RADIOLOGY');
    const items: PortalNotificationItem[] = [];

    const pushOp = (
      key: string,
      titleEn: string,
      titleAr: string,
      bodyEn: string,
      bodyAr: string,
      href: string,
      severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO',
    ) => {
      items.push({
        id: `op:${key}`,
        userId: user.id,
        type: NotifType.GENERAL,
        titleEn,
        titleAr,
        bodyEn,
        bodyAr,
        data: { category: 'OPERATIONAL', href, severity },
        sentAt: now,
        readAt: null,
      });
    };

    try {
      if (user.role === Role.DOCTOR || isAssistant) {
        let facilityDoctorIds = [user.id];
        if (facilityEn) {
          const docs = await this.prisma.user.findMany({
            where: { role: Role.DOCTOR, isActive: true, facilityEn },
            select: { id: true },
          });
          if (docs.length > 0) facilityDoctorIds = docs.map((d) => d.id);
        }
        const scopeIds = isAssistant ? facilityDoctorIds : [user.id];

        const [waitingVisits, emergencyVisits, requestedAppts] = await Promise.all([
          this.prisma.visit.count({ where: { status: VisitStatus.WAITING, doctorId: { in: scopeIds } } }),
          this.prisma.visit.count({ where: { status: VisitStatus.WAITING, isEmergency: true, doctorId: { in: scopeIds } } }),
          this.prisma.appointment.count({ where: { status: AppointmentStatus.REQUESTED, doctorId: { in: scopeIds } } }),
        ]);

        if (isAssistant) {
          if (requestedAppts > 0) {
            pushOp(
              `ast-appts-${requestedAppts}`,
              `${requestedAppts} Pending Appointment Request(s)`,
              `${requestedAppts} طلب حجز موعد بانتظار التأكيد`,
              'Review and confirm requested clinic appointments.',
              'يرجى مراجعة وتأكيد طلبات حجز العيادة الجديدة.',
              '/doctor/appointments',
              'WARNING',
            );
          }
          if (waitingVisits > 0) {
            pushOp(
              `ast-queue-${waitingVisits}`,
              `${waitingVisits} Patient(s) Waiting in Clinic Queue`,
              `${waitingVisits} مريض في طابور انتظار العيادة`,
              emergencyVisits > 0 ? `${emergencyVisits} marked as urgent priority.` : 'Manage waiting list and check-ins.',
              emergencyVisits > 0 ? `منهم ${emergencyVisits} حالة ذات أولوية عاجلة.` : 'تابع قائمة الانتظار وتنظيم دخول المرضى.',
              '/doctor/queue',
              emergencyVisits > 0 ? 'CRITICAL' : 'INFO',
            );
          }
        } else {
          const [pendingFlags, pendingRenewals, pendingLabRefs] = await Promise.all([
            this.prisma.conditionFlag.count({ where: { status: ConditionFlagStatus.PENDING } }),
            this.prisma.renewalRequest.count({ where: { status: RenewalStatus.PENDING } }),
            this.prisma.referral.count({ where: { senderId: user.id, status: ReferralStatus.COMPLETED } }),
          ]);

          if (waitingVisits > 0) {
            pushOp(
              `doc-waiting-${waitingVisits}`,
              `${waitingVisits} Waiting Patient(s) in Queue`,
              `${waitingVisits} مريض بالانتظار في الكشف`,
              emergencyVisits > 0 ? `${emergencyVisits} emergency case(s) flagged.` : 'Open active consultation workspace to call next patient.',
              emergencyVisits > 0 ? `يوجد ${emergencyVisits} حالة طارئة بالأولوية.` : 'افتح شاشة الكشف والاستشارة لمتابعة المرضى.',
              '/doctor/consultation',
              emergencyVisits > 0 ? 'CRITICAL' : 'WARNING',
            );
          }
          if (pendingFlags > 0) {
            pushOp(
              `doc-flags-${pendingFlags}`,
              `${pendingFlags} Unreviewed Clinical Condition Flag(s)`,
              `${pendingFlags} تنبيه إكلينيكي جديد من المعمل بانتظار المراجعة`,
              'Lab flagged potential allergies or chronic conditions for physician review.',
              'أرسل المعمل تنبيهات لحساسيات أو أمراض مزمنة تحتاج اعتماد الطبيب.',
              '/doctor/referrals',
              'WARNING',
            );
          }
          if (pendingRenewals > 0) {
            pushOp(
              `doc-renewals-${pendingRenewals}`,
              `${pendingRenewals} Chronic Prescription Renewal(s)`,
              `${pendingRenewals} طلب تجديد روشتة مزمنة معلق`,
              'Citizens requested chronic medication renewals.',
              'توجد طلبات تجديد لأدوية الأمراض المزمنة بانتظار القرار.',
              '/doctor/renewals',
              'INFO',
            );
          }
          if (pendingLabRefs > 0) {
            pushOp(
              `doc-refs-${pendingLabRefs}`,
              `${pendingLabRefs} Completed Referral(s) to Review`,
              `${pendingLabRefs} إحالة طبية مكتملة جاهزة للمراجعة`,
              'Receiving departments completed your referred patient requests.',
              'أتمت الجهات المحال إليها تنفيذ الإحالات الخاصة بمرضاك.',
              '/doctor/referrals',
              'INFO',
            );
          }
        }
      } else if (user.role === Role.PHARMACIST) {
        const nowPlus30 = new Date(now.getTime() + 30 * 86_400_000);
        const [signedRx, verifiedRx, inventory, expiringCount] = await Promise.all([
          this.prisma.prescription.count({ where: { status: RxStatus.SIGNED } }),
          this.prisma.prescription.count({ where: { status: RxStatus.VERIFIED } }),
          this.prisma.drugInventory.findMany({ select: { quantity: true, reorderAt: true } }),
          this.prisma.drugInventory.count({ where: { expiryDate: { lte: nowPlus30, gte: now } } }),
        ]);
        const lowStockCount = inventory.filter((d) => d.quantity <= d.reorderAt).length;

        if (signedRx > 0) {
          pushOp(
            `pharm-signed-${signedRx}`,
            `${signedRx} Signed Prescription(s) Awaiting Verification`,
            `${signedRx} روشتة إلكترونية موقعة بانتظار التحقق الدوائي`,
            'Verify dosage safety and clinical interactions before dispensing.',
            'يرجى مراجعة الجرعات والتفاعلات واعتماد الصرف.',
            '/pharmacy/rx-verification',
            'WARNING',
          );
        }
        if (verifiedRx > 0) {
          pushOp(
            `pharm-verified-${verifiedRx}`,
            `${verifiedRx} Verified Rx Ready to Dispense`,
            `${verifiedRx} روشتة معتمدة جاهزة للصرف الفوري`,
            'Proceed with dispensing queue handover.',
            'الروشتات جاهزة لتسليم الدواء للمواطنين من طابور الصرف.',
            '/pharmacy/dispensing-queue',
            'INFO',
          );
        }
        if (lowStockCount > 0 || expiringCount > 0) {
          pushOp(
            `pharm-inv-${lowStockCount}-${expiringCount}`,
            `Inventory Alert: ${lowStockCount} Low Stock, ${expiringCount} Expiring`,
            `تنبيه مخزون الصيدلية: ${lowStockCount} ناقص و${expiringCount} قريب الانتهاء`,
            'Restock threshold triggered in drug inventory.',
            'بعض الأصناف الدوائية وصلت للحد الحرج أو اقترب تاريخ انتهائها.',
            '/pharmacy/inventory',
            'WARNING',
          );
        }
      } else if (user.role === Role.LAB_TECH) {
        const isLabRec = spec === 'LAB_RECEPTION' || spec === 'RADIOLOGY_RECEPTION';
        const labFacilityIds = facilityEn
          ? (await this.prisma.user.findMany({ where: { role: Role.LAB_TECH, isActive: true, facilityEn }, select: { id: true } })).map((u) => u.id)
          : [user.id];
        const requestedAppts = await this.prisma.appointment.count({
          where: { status: AppointmentStatus.REQUESTED, doctorId: { in: labFacilityIds.length ? labFacilityIds : [user.id] } },
        });

        if (isRadiology) {
          if (requestedAppts > 0) {
            pushOp(
              `rad-appts-${requestedAppts}`,
              `${requestedAppts} Radiology Appointment Request(s)`,
              `${requestedAppts} طلب حجز أشعة بانتظار التأكيد`,
              'Confirm imaging appointments for citizens.',
              'توجد طلبات حجز فحوصات أشعة جديدة بانتظار التأكيد.',
              '/lab/appointments',
              'WARNING',
            );
          }
          const recentScans = await this.prisma.radiologyUpload.count({
            where: { createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
          });
          if (recentScans > 0) {
            pushOp(
              `rad-scans-${recentScans}`,
              `${recentScans} Radiology Study Upload(s) Today`,
              `${recentScans} دراسة أشعة مرفوعة خلال 24 ساعة`,
              'Inspect uploaded imaging scans and clinical notes.',
              'يمكنك استعراض ومراجعة دراسات الأشعة المرفوعة حديثاً.',
              '/lab/radiology',
              'INFO',
            );
          }
        } else {
          const [intakeSamples, pendingResults, lowReagents] = await Promise.all([
            this.prisma.labSample.count({
              where: { status: { in: [SampleStatus.AWAITING_COLLECTION, SampleStatus.IN_TRANSIT, SampleStatus.RECEIVED] } },
            }),
            this.prisma.labSample.count({
              where: { status: { in: [SampleStatus.PROCESSING, SampleStatus.RESULTS_ENTERED] } },
            }),
            this.prisma.reagent.findMany({ select: { quantity: true, lowStockAt: true } }),
          ]);
          const lowReagentCount = lowReagents.filter((r) => r.quantity <= r.lowStockAt).length;

          if (requestedAppts > 0) {
            pushOp(
              `lab-appts-${requestedAppts}`,
              `${requestedAppts} Lab Appointment Request(s)`,
              `${requestedAppts} طلب موعد سحب عينات بانتظار التأكيد`,
              'Confirm scheduled citizen visits for sample collection.',
              'يرجى تأكيد مواعيد التحاليل المطلوبة للمواطنين.',
              '/lab/appointments',
              'WARNING',
            );
          }
          if (intakeSamples > 0) {
            pushOp(
              `lab-intake-${intakeSamples}`,
              `${intakeSamples} Lab Sample(s) Awaiting Intake / Processing`,
              `${intakeSamples} عينة معملية بانتظار الاستلام والفحص`,
              'Receive barcoded specimens and advance workflow.',
              'قم باستلام العينات وتسجيلها في طابور سحب المعمل.',
              '/lab/sample-intake',
              'WARNING',
            );
          }
          if (!isLabRec && pendingResults > 0) {
            pushOp(
              `lab-results-${pendingResults}`,
              `${pendingResults} Sample(s) Ready for Result Verification`,
              `${pendingResults} عينة بانتظار إدخال أو اعتماد النتائج`,
              'Enter analyte readings and complete dual verification sign-off.',
              'أكمل إدخال نتائج التحاليل والاعتماد النهائي.',
              '/lab/results',
              'INFO',
            );
          }
          if (!isLabRec && lowReagentCount > 0) {
            pushOp(
              `lab-reagents-${lowReagentCount}`,
              `${lowReagentCount} Low-Stock Lab Reagent(s)`,
              `انخفاض رصيد ${lowReagentCount} كاشف ومحلول معملي`,
              'Replenish critical lab reagents.',
              'بعض محاليل وكواشف المعمل اقتربت من نفاد المخزون.',
              '/lab/reagents',
              'WARNING',
            );
          }
        }
      } else if (user.role === Role.HOSPITAL_STAFF) {
        const [activeEr, criticalEr, pendingRefs, scheduledOr] = await Promise.all([
          this.prisma.erCase.count({ where: { status: { in: [ErStatus.TRIAGE, ErStatus.IN_TREATMENT, ErStatus.AWAITING_BED] } } }),
          this.prisma.erCase.count({ where: { acuity: 1, status: { in: [ErStatus.TRIAGE, ErStatus.IN_TREATMENT, ErStatus.AWAITING_BED] } } }),
          this.prisma.referral.count({ where: { target: 'HOSPITAL', status: ReferralStatus.PENDING } }),
          this.prisma.orCase.count({ where: { status: OrCaseStatus.SCHEDULED } }),
        ]);

        if (activeEr > 0) {
          pushOp(
            `hosp-er-${activeEr}-${criticalEr}`,
            `${activeEr} Active ER Case(s) (${criticalEr} Critical)`,
            `${activeEr} حالة طوارئ نشطة (${criticalEr} حرجة)`,
            'Monitor ER triage acuity and bed allocation.',
            'تابع فرز حالات الطوارئ وتسكين الأسرة الحرجة.',
            '/hospital/er-triage',
            criticalEr > 0 ? 'CRITICAL' : 'WARNING',
          );
        }
        if (pendingRefs > 0) {
          pushOp(
            `hosp-refs-${pendingRefs}`,
            `${pendingRefs} Incoming Hospital Referral(s)`,
            `${pendingRefs} إحالة طبية واردة للمستشفى بانتظار القبول`,
            'Review incoming referrals from clinics and ambulance teams.',
            'توجد تحويلات واردة من العيادات تتطلب القبول والتوجيه.',
            '/hospital/er-triage',
            'WARNING',
          );
        }
        if (scheduledOr > 0) {
          pushOp(
            `hosp-or-${scheduledOr}`,
            `${scheduledOr} Scheduled Surgical OR Case(s)`,
            `${scheduledOr} عملية جراحية مجدولة بغرف العمليات`,
            'Verify surgical theater readiness and staffing.',
            'تأكد من جاهزية غرف العمليات والطاقم الجراحي.',
            '/hospital/surgical',
            'INFO',
          );
        }
      } else if (user.role === Role.RECEPTIONIST) {
        const [unverifiedPhones, pendingDel] = await Promise.all([
          this.prisma.patient.count({ where: { phoneVerifiedAt: null } }),
          this.prisma.patient.count({ where: { deletionRequestedAt: { not: null } } }),
        ]);
        if (unverifiedPhones > 0) {
          pushOp(
            `rec-unverified-${unverifiedPhones}`,
            `${unverifiedPhones} Citizen(s) Pending Mobile OTP Verification`,
            `${unverifiedPhones} مواطن بانتظار تفعيل وتوثيق رقم الهاتف`,
            'Verify citizen mobile numbers in the national registry.',
            'تابع استكمال توثيق أرقام الهواتف للمواطنين المسجلين.',
            '/reception/citizens',
            'INFO',
          );
        }
        if (pendingDel > 0) {
          pushOp(
            `rec-del-${pendingDel}`,
            `${pendingDel} Pending Citizen Deletion Request(s)`,
            `${pendingDel} طلب حذف قيد انتظار اعتماد الوزارة`,
            'Awaiting final Ministry Executive decision.',
            'بانتظار مراجعة واعتماد القيادات التنفيذية بوزارة الصحة.',
            '/reception/citizens',
            'INFO',
          );
        }
      } else if (user.role === Role.EXECUTIVE) {
        const [pendingDel, criticalEr] = await Promise.all([
          this.prisma.patient.count({ where: { deletionRequestedAt: { not: null } } }),
          this.prisma.erCase.count({ where: { acuity: 1, status: { in: [ErStatus.TRIAGE, ErStatus.IN_TREATMENT, ErStatus.AWAITING_BED] } } }),
        ]);
        if (pendingDel > 0) {
          pushOp(
            `exec-del-${pendingDel}`,
            `${pendingDel} Citizen Deletion Approval(s) Pending Ministry Action`,
            `${pendingDel} طلب حذف مواطن بانتظار اعتماد الوزارة النهائي`,
            'Open MoHP Strategy Console to approve or reject pending citizen deletions.',
            'يرجى مراجعة طلبات الحذف والبت فيها من لوحة استراتيجية وزارة الصحة.',
            '/analytics/ministries',
            'CRITICAL',
          );
        }
        if (criticalEr > 0) {
          pushOp(
            `exec-er-${criticalEr}`,
            `${criticalEr} Nationwide Acuity-1 ER Case(s)`,
            `${criticalEr} حالة طوارئ حرجة المستوى الأول على مستوى الجمهورية`,
            'Monitor national emergency readiness and ICU bed capacity.',
            'راقب مؤشرات الجاهزية والأسرة الحرجة في غرفة القيادة.',
            '/analytics/facility-capacity',
            'WARNING',
          );
        }
      } else if (user.role === Role.ADMIN) {
        const since24h = new Date(now.getTime() - 24 * 3600_000);
        const [lockedUsers, pendingPw, failedAudits] = await Promise.all([
          this.prisma.user.count({ where: { role: { not: Role.PATIENT }, OR: [{ lockedUntil: { gt: now } }, { failedLogins: { gte: 3 } }] } }),
          this.prisma.user.count({ where: { role: { not: Role.PATIENT }, mustChangePassword: true } }),
          this.prisma.auditLog.count({ where: { statusCode: { gte: 400 }, at: { gte: since24h } } }),
        ]);
        if (lockedUsers > 0) {
          pushOp(
            `adm-locked-${lockedUsers}`,
            `${lockedUsers} Staff Account(s) Locked or High Failed Logins`,
            `تنبيه أمني: ${lockedUsers} حساب موظف مقفل أو لديه محاولات دخول فاشلة`,
            'Review staff accounts and reset credentials if needed.',
            'يرجى مراجعة حالة الحسابات المقفلة داخل المنشآت.',
            '/admin/users',
            'CRITICAL',
          );
        }
        if (pendingPw > 0) {
          pushOp(
            `adm-temp-${pendingPw}`,
            `${pendingPw} Staff Account(s) Awaiting Initial Password Change`,
            `${pendingPw} حساب موظف جديد لم يغيّر كلمة المرور المؤقتة بعد`,
            'Track onboarding progress for newly created staff.',
            'حسابات مفعّلة حديثاً وما زالت تستخدم كلمة المرور المؤقتة.',
            '/admin/users',
            'INFO',
          );
        }
        if (failedAudits > 0) {
          pushOp(
            `adm-audit-${failedAudits}`,
            `${failedAudits} Failed / Rejected API Request(s) in Last 24h`,
            `${failedAudits} محاولة وصول مرفوضة أو خاطئة خلال 24 ساعة`,
            'Inspect SOC audit logs for denied role attempts or errors.',
            'راجع سجل المراجعة الأمني لمتابعة المحاولات المرفوضة.',
            '/admin/users',
            'WARNING',
          );
        }
      }
    } catch {
      // Never fail notifications endpoint if an optional operational aggregation throws
    }

    return items;
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
            role: { in: [Role.HOSPITAL_STAFF, Role.DOCTOR] },
            facilityEn,
          },
          select: { id: true, role: true },
          take: 25,
        })
      : [];

    if (responders.length < 2) {
      const extra = await this.prisma.user.findMany({
        where: {
          isActive: true,
          role: { in: [Role.HOSPITAL_STAFF, Role.DOCTOR] },
          id: { notIn: responders.map((r) => r.id) },
        },
        select: { id: true, role: true },
        take: 25 - responders.length,
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
        type: NotifType.GENERAL,
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

  @Post('emergency-alert')
  @Roles(Role.DOCTOR, Role.HOSPITAL_STAFF, Role.LAB_TECH, Role.PHARMACIST, Role.RECEPTIONIST, Role.EXECUTIVE)
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
