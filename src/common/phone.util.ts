import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Normalizes Egyptian & international phone inputs into strict E.164 format.
 * Examples:
 * - "01012345678"   -> "+201012345678"
 * - "00201012345678" -> "+201012345678"
 * - "+20 101 234 5678" -> "+201012345678"
 */
export function normalizePhoneE164(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  const asciiDigits = raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  const cleaned = asciiDigits.trim().replace(/[\s\-().\u200E\u200F\u202A-\u202E]/g, '');
  if (!cleaned) return null;

  let candidate = cleaned;
  if (/^\+2001[0125]\d{8}$/.test(cleaned)) {
    candidate = `+20${cleaned.slice(4)}`;
  } else if (/^002001[0125]\d{8}$/.test(cleaned)) {
    candidate = `+20${cleaned.slice(5)}`;
  } else if (/^01[0125]\d{8}$/.test(cleaned)) {
    candidate = `+20${cleaned.slice(1)}`;
  } else if (/^1[0125]\d{8}$/.test(cleaned)) {
    candidate = `+20${cleaned}`;
  } else if (/^00201[0125]\d{8}$/.test(cleaned)) {
    candidate = `+20${cleaned.slice(4)}`;
  } else if (/^201[0125]\d{8}$/.test(cleaned)) {
    candidate = `+${cleaned}`;
  } else if (cleaned.startsWith('00')) {
    candidate = `+${cleaned.slice(2)}`;
  }

  if (candidate.startsWith('+20') && !/^\+201[0125]\d{8}$/.test(candidate)) {
    throw new BadRequestException('INVALID_PHONE_NUMBER');
  }

  if (!/^\+[1-9]\d{8,14}$/.test(candidate)) {
    throw new BadRequestException('INVALID_PHONE_NUMBER');
  }
  return candidate;
}

/** Masks the middle digits of an E.164 phone number for privacy-safe UI display. */
export function maskPhone(e164?: string | null): string | null {
  if (!e164) return null;
  if (e164.length <= 6) return e164;
  return `${e164.slice(0, 5)}••••••${e164.slice(-2)}`;
}

/**
 * One mobile number belongs to exactly one citizen. Because every input format
 * (010…, +2010…, 002010…) is normalized to E.164 first, "similar" spellings of the
 * same number are caught here too. The database also enforces this with a unique index.
 */
export async function assertPhoneAvailable(
  prisma: PrismaService,
  phoneE164: string | null,
  exceptPatientId?: string,
): Promise<void> {
  if (!phoneE164) return;
  const owner = await prisma.patient.findFirst({
    where: { phone: phoneE164, ...(exceptPatientId ? { id: { not: exceptPatientId } } : {}) },
    select: { id: true },
  });
  if (owner) throw new ConflictException('PHONE_ALREADY_USED');
}

/** Converts a race-condition unique-index violation on `Patient.phone` into the same friendly 409. */
export function rethrowPhoneConflict(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta ?? {}).includes('phone')
  ) {
    throw new ConflictException('PHONE_ALREADY_USED');
  }
  throw err;
}
