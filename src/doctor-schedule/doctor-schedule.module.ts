import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AppointmentStatus, NotifType, Role } from '@prisma/client';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, AuthUser, CurrentUser, Roles } from '../common/decorators';
import { getGovernorateMeta, haversineKm, inferLocationFromFacilityText, normalizeGovernorate, resolveGovernorateFromCoords } from '../common/egypt-geo.util';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

// ─────────────────────────────────────────────────────────────────────────────
//  DTOs
// ─────────────────────────────────────────────────────────────────────────────

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateScheduleDto {
  /** Day of week: 0 = Sunday, 6 = Saturday (JS convention). */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  /** Slot window start — 24-hour "HH:MM". */
  @IsString()
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM (24-hour)' })
  startTime: string;

  /** Slot window end — 24-hour "HH:MM". */
  @IsString()
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM (24-hour)' })
  endTime: string;

  /** Appointment slot duration in minutes. Defaults to 20. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  slotMinutes?: number;
}

export class DeleteScheduleDto {
  /** UUID of the DoctorSchedule row to delete. */
  @IsString()
  scheduleId: string;
}

export class CreateAddressChangeDto {
  @IsString()
  @MaxLength(80)
  newGovernorate: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  newCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  newDistrict?: string;

  @IsString()
  @Length(3, 200)
  newAddressAr: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  newAddressEn?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  newLatitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  newLongitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface TimeSlot {
  slotStart: string;
  slotEnd: string;
}

interface DoctorSummary {
  id: string;
  fullNameEn: string;
  fullNameAr: string;
  specialityEn: string | null;
  specialityAr: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "HH:MM" into total minutes from midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Format total minutes from midnight back to "HH:MM". */
function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Given an ISO date string (YYYY-MM-DD) return the day-of-week integer
 * using JS convention (0 = Sunday … 6 = Saturday) in UTC so that the
 * date doesn't shift with the server's local timezone.
 */
function dayOfWeekFromDate(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Build Date objects for the start and end of a calendar day (UTC) from an
 * ISO date string.  These are used to filter Appointment rows by scheduledAt.
 */
function dayBounds(dateStr: string): { dayStart: Date; dayEnd: Date } {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dayStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  return { dayStart, dayEnd };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DoctorScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifs: NotificationsService,
  ) {}

  // ── Schedule CRUD ──────────────────────────────────────────────────────────

  /** Returns the authenticated doctor's schedule ordered by dayOfWeek then startTime. */
  async getMySchedule(doctorId: string, role?: Role) {
    const own = await this.prisma.doctorSchedule.findMany({
      where: { doctorId, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
    if (own.length > 0 || role === Role.DOCTOR) return own;
    const firstDoc = await this.prisma.user.findFirst({
      where: { role: Role.DOCTOR, isActive: true },
      select: { id: true },
    });
    if (!firstDoc) return [];
    return this.prisma.doctorSchedule.findMany({
      where: { doctorId: firstDoc.id, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  /**
   * Returns a specific doctor's schedule — used by reception when booking an
   * appointment on behalf of a patient.
   */
  async getScheduleFor(doctorId: string) {
    const doctor = await this.prisma.user.findFirst({
      where: { id: doctorId, role: Role.DOCTOR, isActive: true },
      select: { id: true },
    });
    if (!doctor) throw new NotFoundException('DOCTOR_NOT_FOUND');

    return this.prisma.doctorSchedule.findMany({
      where: { doctorId, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  /**
   * Creates or updates a schedule entry.
   * Uniqueness is enforced on (doctorId, dayOfWeek, startTime).
   * If a soft-deleted row already exists for that combination it is reactivated.
   */
  async upsertSlot(dto: CreateScheduleDto, doctorId: string) {
    const startMins = toMinutes(dto.startTime);
    const endMins = toMinutes(dto.endTime);

    if (endMins <= startMins) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const window = endMins - startMins;
    const slotMinutes = dto.slotMinutes ?? 20;

    if (slotMinutes > window) {
      throw new BadRequestException(
        'slotMinutes must not exceed the time window (endTime − startTime)',
      );
    }

    // Upsert on the unique index (doctorId, dayOfWeek, startTime).
    return this.prisma.doctorSchedule.upsert({
      where: {
        doctorId_dayOfWeek_startTime: {
          doctorId,
          dayOfWeek: dto.dayOfWeek,
          startTime: dto.startTime,
        },
      },
      create: {
        doctorId,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
        slotMinutes,
        isActive: true,
      },
      update: {
        endTime: dto.endTime,
        slotMinutes,
        isActive: true,
      },
    });
  }

  /**
   * Hard-deletes a single schedule row.  Only the owning doctor may delete it.
   */
  async deleteSlot(scheduleId: string, doctorId: string) {
    const row = await this.prisma.doctorSchedule.findUnique({
      where: { id: scheduleId },
    });
    if (!row) throw new NotFoundException('SCHEDULE_SLOT_NOT_FOUND');
    if (row.doctorId !== doctorId) throw new ForbiddenException('NOT_YOUR_SLOT');

    await this.prisma.doctorSchedule.delete({ where: { id: scheduleId } });
    return { deleted: true, id: scheduleId };
  }

  // ── Slot availability ──────────────────────────────────────────────────────

  /**
   * Computes free appointment slots for a doctor on a given calendar date.
   *
   * Algorithm:
   *  1. Find the DoctorSchedule row matching dayOfWeek.
   *  2. Enumerate all candidate HH:MM slots by splitting the window by slotMinutes.
   *  3. Fetch all CONFIRMED or REQUESTED appointments for that doctor on that date.
   *  4. Remove candidate slots whose slotStart collides with an existing appointment's
   *     scheduledAt time (truncated to HH:MM in UTC).
   *
   * Returns an array of { slotStart, slotEnd } objects.
   */
  async getAvailableSlots(doctorId: string, date: string): Promise<TimeSlot[]> {
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be in YYYY-MM-DD format');
    }

    const dayOfWeek = dayOfWeekFromDate(date);

    const schedule = await this.prisma.doctorSchedule.findFirst({
      where: { doctorId, dayOfWeek, isActive: true },
      orderBy: { startTime: 'asc' },
    });

    const effectiveSchedule = schedule ?? { startTime: '09:00', endTime: '16:00', slotMinutes: 20 };

    // Generate all candidate slots for this window.
    const allSlots: TimeSlot[] = [];
    const startMins = toMinutes(effectiveSchedule.startTime);
    const endMins = toMinutes(effectiveSchedule.endTime);
    const step = effectiveSchedule.slotMinutes;

    for (let cursor = startMins; cursor + step <= endMins; cursor += step) {
      allSlots.push({
        slotStart: fromMinutes(cursor),
        slotEnd: fromMinutes(cursor + step),
      });
    }

    if (allSlots.length === 0) return [];

    // Fetch booked appointments for this doctor on this date.
    const bookedStatuses: AppointmentStatus[] = [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.REQUESTED,
    ];
    const { dayStart, dayEnd } = dayBounds(date);

    const bookedAppointments = await this.prisma.appointment.findMany({
      where: {
        doctorId,
        status: { in: bookedStatuses },
        scheduledAt: { gte: dayStart, lte: dayEnd },
      },
      select: { scheduledAt: true },
    });

    // Build a set of already-taken "HH:MM" start times.
    const takenTimes = new Set<string>(
      bookedAppointments
        .filter((a) => a.scheduledAt !== null)
        .map((a) => {
          const d = a.scheduledAt as Date;
          return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        }),
    );

    return allSlots.filter((slot) => !takenTimes.has(slot.slotStart));
  }

  // ── Doctor & Lab listing ───────────────────────────────────────────────────

  private resolveGeoContext(query?: {
    lat?: string;
    lng?: string;
    governorate?: string;
    strictGeo?: string;
    radiusKm?: string;
  }) {
    const lat = query?.lat !== undefined ? Number(query.lat) : NaN;
    const lng = query?.lng !== undefined ? Number(query.lng) : NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const resolved = hasCoords ? resolveGovernorateFromCoords(lat, lng) : null;
    const targetGov =
      normalizeGovernorate(query?.governorate) ?? resolved?.code ?? null;
    const strictGeo = query?.strictGeo === 'true';
    const radiusKmRaw = query?.radiusKm ? Number(query.radiusKm) : 35;
    const radiusKm = Number.isFinite(radiusKmRaw) && radiusKmRaw > 0 ? radiusKmRaw : 35;
    return { hasCoords, lat, lng, targetGov, strictGeo, radiusKm, resolved };
  }

  private enrichAndFilterByGeo<
    T extends {
      governorate?: string | null;
      city?: string | null;
      district?: string | null;
      addressEn?: string | null;
      addressAr?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      facilityEn?: string | null;
      facilityAr?: string | null;
    },
  >(
    rows: T[],
    geo: ReturnType<DoctorScheduleService['resolveGeoContext']>,
  ) {
    const enriched = rows.map((row) => {
      const inferred = inferLocationFromFacilityText(row.facilityEn, row.facilityAr);
      const gov =
        normalizeGovernorate(row.governorate) ??
        normalizeGovernorate(row.addressAr) ??
        inferred.governorate;
      const meta = getGovernorateMeta(gov);
      const itemLat = row.latitude ?? meta?.lat ?? inferred.latitude;
      const itemLng = row.longitude ?? meta?.lng ?? inferred.longitude;
      const distanceKm = geo.hasCoords
        ? haversineKm(geo.lat, geo.lng, itemLat, itemLng)
        : null;
      return {
        ...row,
        governorate: gov,
        governorateAr: meta?.ar ?? gov,
        governorateEn: meta?.en ?? gov,
        city: row.city ?? meta?.en ?? inferred.city,
        district: row.district ?? null,
        addressAr: row.addressAr ?? inferred.addressAr,
        addressEn: row.addressEn ?? inferred.addressEn,
        latitude: itemLat,
        longitude: itemLng,
        distanceKm,
      };
    });

    const filtered =
      geo.strictGeo && (geo.targetGov || geo.hasCoords)
        ? enriched.filter((item) => {
            const govMatch = geo.targetGov ? item.governorate === geo.targetGov : false;
            const distMatch =
              item.distanceKm !== null ? item.distanceKm <= geo.radiusKm : false;
            return govMatch || distMatch;
          })
        : enriched;

    if (geo.hasCoords) {
      filtered.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    }
    return filtered;
  }

  /** Lists all active standalone Clinic physicians nationwide (excludes inpatient Hospital physicians). */
  async listDoctors(query?: {
    lat?: string;
    lng?: string;
    governorate?: string;
    strictGeo?: string;
    radiusKm?: string;
  }) {
    const [doctors, hospStaff] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: Role.DOCTOR, isActive: true },
        select: {
          id: true,
          fullNameEn: true,
          fullNameAr: true,
          specialityEn: true,
          specialityAr: true,
          facilityEn: true,
          facilityAr: true,
          licenseNo: true,
          governorate: true,
          city: true,
          district: true,
          addressEn: true,
          addressAr: true,
          latitude: true,
          longitude: true,
        },
        orderBy: { fullNameEn: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { role: Role.HOSPITAL_STAFF, isActive: true },
        select: { facilityEn: true },
      }),
    ]);

    const hospSet = new Set(
      hospStaff
        .map((h) => h.facilityEn?.trim().toLowerCase())
        .filter((x): x is string => Boolean(x)),
    );

    const clinicDoctors = doctors
      .filter((d) => !d.facilityEn || !hospSet.has(d.facilityEn.trim().toLowerCase()))
      .map((d) => ({ ...d, facilityType: 'CLINIC' as const }));

    const geo = this.resolveGeoContext(query);
    return this.enrichAndFilterByGeo(clinicDoctors, geo);
  }

  /** Lists all registered laboratories across Egypt with their reception officer ID for appointment routing. */
  async listLabs(query?: {
    lat?: string;
    lng?: string;
    governorate?: string;
    strictGeo?: string;
    radiusKm?: string;
  }) {
    const labStaff = await this.prisma.user.findMany({
      where: { role: Role.LAB_TECH, isActive: true },
      select: {
        id: true,
        fullNameEn: true,
        fullNameAr: true,
        specialityEn: true,
        specialityAr: true,
        facilityEn: true,
        facilityAr: true,
        licenseNo: true,
        governorate: true,
        city: true,
        district: true,
        addressEn: true,
        addressAr: true,
        latitude: true,
        longitude: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const sorted = [...labStaff].sort((a, b) => {
      const aRec = a.specialityEn === 'LAB_RECEPTION' || a.specialityEn === 'RADIOLOGY_RECEPTION' ? 0 : 1;
      const bRec = b.specialityEn === 'LAB_RECEPTION' || b.specialityEn === 'RADIOLOGY_RECEPTION' ? 0 : 1;
      return aRec - bRec;
    });
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      nameEn: string;
      nameAr: string;
      staffNameEn: string;
      staffNameAr: string;
      licenseNo: string | null;
      labSubType: 'ANALYSIS' | 'RADIOLOGY';
      facilityEn: string | null;
      facilityAr: string | null;
      governorate: string | null;
      city: string | null;
      district: string | null;
      addressEn: string | null;
      addressAr: string | null;
      latitude: number | null;
      longitude: number | null;
    }> = [];
    for (const u of sorted) {
      const key = u.facilityEn || u.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const isRadiology =
        u.specialityEn?.toUpperCase().startsWith('RADIOLOGY') ||
        u.licenseNo?.toUpperCase().startsWith('RAD-');
      out.push({
        id: u.id,
        nameEn: u.facilityEn || u.fullNameEn,
        nameAr: u.facilityAr || u.fullNameAr,
        staffNameEn: u.fullNameEn,
        staffNameAr: u.fullNameAr,
        licenseNo: u.licenseNo,
        labSubType: isRadiology ? 'RADIOLOGY' : 'ANALYSIS',
        facilityEn: u.facilityEn,
        facilityAr: u.facilityAr,
        governorate: u.governorate,
        city: u.city,
        district: u.district,
        addressEn: u.addressEn,
        addressAr: u.addressAr,
        latitude: u.latitude,
        longitude: u.longitude,
      });
    }
    const geo = this.resolveGeoContext(query);
    return this.enrichAndFilterByGeo(out, geo);
  }

  resolveLocation(lat: number, lng: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('INVALID_COORDINATES');
    }
    const res = resolveGovernorateFromCoords(lat, lng);
    return {
      governorateCode: res.code,
      governorateAr: res.ar,
      governorateEn: res.en,
      distanceKm: res.distanceKm,
      latitude: lat,
      longitude: lng,
    };
  }

  async createAddressChangeRequest(doctorId: string, dto: CreateAddressChangeDto) {
    const doc = await this.prisma.user.findUnique({
      where: { id: doctorId },
      select: { id: true, fullNameAr: true, fullNameEn: true, facilityAr: true, facilityEn: true, addressAr: true, addressEn: true, governorate: true },
    });
    if (!doc) throw new NotFoundException('DOCTOR_NOT_FOUND');

    const normGov = normalizeGovernorate(dto.newGovernorate) ?? dto.newGovernorate.trim().toUpperCase();
    const meta = getGovernorateMeta(normGov);
    const created = await this.prisma.addressChangeRequest.create({
      data: {
        doctorId,
        currentAddressAr: doc.addressAr || doc.governorate || doc.facilityAr || null,
        currentAddressEn: doc.addressEn || doc.governorate || doc.facilityEn || null,
        newGovernorate: normGov,
        newCity: dto.newCity?.trim() || meta?.en || null,
        newDistrict: dto.newDistrict?.trim() || null,
        newAddressAr: dto.newAddressAr.trim(),
        newAddressEn: dto.newAddressEn?.trim() || dto.newAddressAr.trim(),
        newLatitude: typeof dto.newLatitude === 'number' ? dto.newLatitude : meta?.lat ?? null,
        newLongitude: typeof dto.newLongitude === 'number' ? dto.newLongitude : meta?.lng ?? null,
        reason: dto.reason?.trim() || null,
      },
    });

    await this.notifs
      .notifyRoles(
        [Role.ADMIN],
        NotifType.ADDRESS_CHANGE_REQUEST,
        `Doctor Address Change Request — ${doc.fullNameEn}`,
        `طلب تغيير عنوان عيادة — د. ${doc.fullNameAr}`,
        `Dr. ${doc.fullNameEn} requested relocation to ${dto.newAddressEn?.trim() || dto.newAddressAr.trim()} (${meta?.en ?? normGov}).`,
        `طلب د. ${doc.fullNameAr} (${doc.facilityAr ?? ''}) تحديث عنوان العيادة إلى: ${dto.newAddressAr.trim()} (${meta?.ar ?? normGov}).`,
        {
          category: 'ADDRESS_CHANGE',
          requestId: created.id,
          doctorId,
          href: '/admin/users',
          severity: 'WARNING',
        },
      )
      .catch(() => undefined);

    return created;
  }

  listMyAddressChangeRequests(doctorId: string) {
    return this.prisma.addressChangeRequest.findMany({
      where: { doctorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /** Lists all registered hospitals across Egypt for referrals and hospital directory. */
  async listHospitals() {
    const staff = await this.prisma.user.findMany({
      where: { role: Role.HOSPITAL_STAFF, isActive: true },
      select: {
        id: true,
        fullNameEn: true,
        fullNameAr: true,
        facilityEn: true,
        facilityAr: true,
        licenseNo: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      nameEn: string;
      nameAr: string;
      staffNameEn: string;
      staffNameAr: string;
      licenseNo: string | null;
    }> = [];
    for (const u of staff) {
      const key = u.facilityEn || u.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: u.id,
        nameEn: u.facilityEn || u.fullNameEn,
        nameAr: u.facilityAr || u.fullNameAr,
        staffNameEn: u.fullNameEn,
        staffNameAr: u.fullNameAr,
        licenseNo: u.licenseNo,
      });
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Controller
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('schedule')
@ApiBearerAuth()
@Controller('schedule')
export class DoctorScheduleController {
  constructor(private readonly svc: DoctorScheduleService) {}

  // ── Doctor & Lab listing ───────────────────────────────────────────────────

  /**
   * GET /schedule/doctors
   * Lists all active doctors — used by the booking UI in the receptionist and
   * patient-facing apps to populate the "choose a doctor" step.
   */
  @Audit('SCHEDULE')
  @Roles(Role.RECEPTIONIST, Role.DOCTOR, Role.LAB_TECH, Role.PATIENT)
  @Get('doctors')
  listDoctors(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('governorate') governorate?: string,
    @Query('strictGeo') strictGeo?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    return this.svc.listDoctors({ lat, lng, governorate, strictGeo, radiusKm });
  }

  /**
   * GET /schedule/labs
   * Lists all registered laboratories across Egypt for citizen lab appointment booking.
   */
  @Audit('SCHEDULE')
  @Roles(Role.RECEPTIONIST, Role.DOCTOR, Role.LAB_TECH, Role.PATIENT)
  @Get('labs')
  listLabs(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('governorate') governorate?: string,
    @Query('strictGeo') strictGeo?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    return this.svc.listLabs({ lat, lng, governorate, strictGeo, radiusKm });
  }

  @Audit('SCHEDULE')
  @Roles(Role.PATIENT, Role.DOCTOR, Role.RECEPTIONIST, Role.ADMIN)
  @Get('resolve-location')
  resolveLocation(@Query('lat') lat: string, @Query('lng') lng: string) {
    return this.svc.resolveLocation(Number(lat), Number(lng));
  }

  @Audit('SCHEDULE')
  @Roles(Role.DOCTOR)
  @Post('address-change-requests')
  requestAddressChange(@Body() dto: CreateAddressChangeDto, @CurrentUser() user: AuthUser) {
    return this.svc.createAddressChangeRequest(user.id, dto);
  }

  @Audit('SCHEDULE')
  @Roles(Role.DOCTOR)
  @Get('address-change-requests/my')
  myAddressChangeRequests(@CurrentUser() user: AuthUser) {
    return this.svc.listMyAddressChangeRequests(user.id);
  }

  /**
   * GET /schedule/hospitals
   * Lists all registered hospitals across Egypt for inter-facility referrals and bed coordination.
   */
  @Audit('SCHEDULE')
  @Roles(Role.RECEPTIONIST, Role.DOCTOR, Role.LAB_TECH, Role.HOSPITAL_STAFF, Role.PATIENT)
  @Get('hospitals')
  listHospitals() {
    return this.svc.listHospitals();
  }

  // ── Available slots ────────────────────────────────────────────────────────

  /**
   * GET /schedule/doctors/:doctorId/slots?date=YYYY-MM-DD
   * Returns the free appointment slots for a specific doctor on a calendar date.
   * Used by reception and patients during the booking flow.
   */
  @Audit('SCHEDULE')
  @Roles(Role.RECEPTIONIST, Role.PATIENT, Role.DOCTOR, Role.LAB_TECH)
  @ApiQuery({ name: 'date', description: 'Calendar date (YYYY-MM-DD)', required: true })
  @Get('doctors/:doctorId/slots')
  getAvailableSlots(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query('date') date: string,
  ) {
    if (!date) throw new BadRequestException('Query parameter "date" is required');
    return this.svc.getAvailableSlots(doctorId, date);
  }

  // ── Doctor's own schedule ──────────────────────────────────────────────────

  /**
   * GET /schedule/my
   * Returns the authenticated doctor's weekly schedule template.
   */
  @Audit('SCHEDULE')
  @Roles(Role.DOCTOR)
  @Get('my')
  getMySchedule(@CurrentUser() user: AuthUser) {
    return this.svc.getMySchedule(user.id, user.role);
  }

  /**
   * POST /schedule/my
   * Adds or updates a weekly recurring slot.
   * Uniqueness key: (doctorId, dayOfWeek, startTime).  If the slot already
   * exists it is updated in-place (endTime and slotMinutes are refreshed).
   */
  @Audit('SCHEDULE')
  @Roles(Role.DOCTOR)
  @Post('my')
  upsertSlot(@Body() dto: CreateScheduleDto, @CurrentUser() user: AuthUser) {
    return this.svc.upsertSlot(dto, user.id);
  }

  /**
   * DELETE /schedule/my/:id
   * Removes one of the authenticated doctor's schedule rows.
   * Returns 403 if the row belongs to a different doctor.
   */
  @Audit('SCHEDULE')
  @Roles(Role.DOCTOR)
  @Delete('my/:id')
  deleteSlot(
    @Param('id', ParseUUIDPipe) scheduleId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.deleteSlot(scheduleId, user.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Module
// ─────────────────────────────────────────────────────────────────────────────

@Module({
  imports: [NotificationsModule],
  controllers: [DoctorScheduleController],
  providers: [DoctorScheduleService],
  exports: [DoctorScheduleService],
})
export class DoctorScheduleModule {}
