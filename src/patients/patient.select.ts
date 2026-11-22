import { Prisma } from '@prisma/client';

/** Patient fields selected across modules; AuditInterceptor automatically decrypts nationalIdEnc -> nationalId and strips nationalIdEnc. */
export const PATIENT_PUBLIC_SELECT = {
  id: true,
  mti: true,
  nationalIdEnc: true,
  fullNameEn: true,
  fullNameAr: true,
  sex: true,
  birthDate: true,
  bloodType: true,
  phone: true,
  phoneVerifiedAt: true,
  governorate: true,
  city: true,
  district: true,
  addressEn: true,
  addressAr: true,
  photoUrl: true,
  insuranceActive: true,
  organDonor: true,
  allergies: true,
  chronicConditions: true,
  deletionRequestedAt: true,
  deletionReason: true,
  deletionRequestedById: true,
  deletionRequestedByName: true,
} satisfies Prisma.PatientSelect;
