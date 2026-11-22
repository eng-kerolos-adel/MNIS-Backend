import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { App, applicationDefault, cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env';

/** Normalizes any hospital/clinic name into a Firestore-safe ASCII facility key. */
export function slugifyFacility(name?: string | null): string {
  const raw = (name ?? '').trim().toLowerCase();
  if (!raw) return 'national';
  const slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'national';
}

export interface LiveQueueStats {
  currentTicketNo: string | null;
  waitingCount: number;
  emergencyWaitingCount: number;
}

export interface LiveErStats {
  availableBeds: number;
  occupiedBeds: number;
  erWaiting: number;
  erCritical: number;
}

export interface FcmPayload {
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  type: string;
  data?: Record<string, unknown>;
}

const INVALID_FCM_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: App | null = null;
  private authReady = false;
  private firestoreReady = false;
  private messagingReady = false;
  private projectId = 'mnis-egypt-dev';

  onModuleInit() {
    this.projectId =
      env.MNIS_FIREBASE_PROJECT_ID ||
      env.FIREBASE_PROJECT_ID ||
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      'mnis-egypt-dev';
    const hasAuthEmulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
    const existing = getApps()[0];
    if (existing) {
      this.app = existing;
      this.authReady = true;
      this.firestoreReady = true;
      this.messagingReady = !hasAuthEmulator;
      if (!hasAuthEmulator) {
        void this.ensurePhoneRecaptchaConfig();
      }
      return;
    }

    const serviceAccount = this.parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const hasAdcFile = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const hasFirestoreEmulator = Boolean(env.FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST);
    const isCloudRun = Boolean(
      process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || process.env.FUNCTION_TARGET,
    );

    try {
      if (serviceAccount) {
        this.projectId = serviceAccount.projectId || this.projectId;
        this.app = initializeApp({
          credential: cert(serviceAccount),
          projectId: this.projectId,
        });
        this.authReady = true;
        this.firestoreReady = true;
        this.messagingReady = !hasAuthEmulator;
        this.logger.log(`Firebase Admin initialized with service account (${this.projectId})`);
        if (!hasAuthEmulator) {
          void this.ensurePhoneRecaptchaConfig();
        }
        return;
      }

      if (hasAdcFile || isCloudRun) {
        this.app = initializeApp({
          credential: applicationDefault(),
          projectId: this.projectId,
        });
        this.authReady = true;
        this.firestoreReady = true;
        this.messagingReady = !hasAuthEmulator;
        this.logger.log(`Firebase Admin initialized with ADC (${this.projectId})`);
        if (!hasAuthEmulator) {
          void this.ensurePhoneRecaptchaConfig();
        }
        return;
      }

      if (hasAuthEmulator || hasFirestoreEmulator) {
        this.app = initializeApp({ projectId: this.projectId });
        this.authReady = hasAuthEmulator;
        this.firestoreReady = hasFirestoreEmulator;
        this.messagingReady = false;
        this.logger.log(
          `Firebase Admin initialized in emulator mode (project=${this.projectId}, auth=${this.authReady}, firestore=${this.firestoreReady})`,
        );
        return;
      }

      this.logger.warn(
        'Firebase Admin disabled — set FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST or FIREBASE_SERVICE_ACCOUNT_JSON to enable',
      );
    } catch (err) {
      this.logger.warn(`Firebase Admin initialization skipped: ${(err as Error).message}`);
      this.app = null;
      this.authReady = false;
      this.firestoreReady = false;
      this.messagingReady = false;
    }
  }

  private parseServiceAccount(raw?: string): ServiceAccount | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    try {
      const jsonStr = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr) as Record<string, string>;
      if (!parsed.project_id && !parsed.projectId) return null;
      return {
        projectId: parsed.project_id ?? parsed.projectId,
        clientEmail: parsed.client_email ?? parsed.clientEmail,
        privateKey: (parsed.private_key ?? parsed.privateKey)?.replace(/\\n/g, '\n'),
      };
    } catch (err) {
      this.logger.warn(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${(err as Error).message}`);
      return null;
    }
  }

  isEnabled(): boolean {
    return Boolean(this.app && (this.authReady || this.firestoreReady || this.messagingReady));
  }

  async createCustomToken(user: {
    id: string;
    role: string;
    facilityEn?: string | null;
    patientId?: string | null;
  }) {
    if (!this.app || !this.authReady) {
      throw new ServiceUnavailableException('FIREBASE_NOT_CONFIGURED');
    }
    const claims = {
      role: user.role,
      facilityKey: slugifyFacility(user.facilityEn),
      patientId: user.patientId ?? null,
    };
    try {
      const token = await getAuth(this.app).createCustomToken(user.id, claims);
      return {
        token,
        projectId: this.projectId,
        claims,
      };
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (msg.includes('signBlob') || msg.includes('insufficient-permission')) {
        this.logger.warn(
          'Firebase custom token minting unavailable without IAM signBlob role — client real-time bridge skipped.',
        );
        throw new ServiceUnavailableException('FIREBASE_CUSTOM_TOKEN_UNAVAILABLE');
      }
      throw err;
    }
  }

  async verifyIdToken(idToken: string) {
    if (!this.app || !this.authReady) {
      throw new ServiceUnavailableException('FIREBASE_NOT_CONFIGURED');
    }
    try {
      return await getAuth(this.app).verifyIdToken(idToken, true);
    } catch {
      throw new UnauthorizedException('INVALID_FIREBASE_TOKEN');
    }
  }

  async sendPushNotification(
    tokens: string[],
    payload: FcmPayload,
  ): Promise<{ sent: number; invalidTokens: string[] }> {
    const cleanTokens = Array.from(new Set(tokens.map((t) => t.trim()).filter(Boolean)));
    if (cleanTokens.length === 0) return { sent: 0, invalidTokens: [] };

    if (!this.app || !this.messagingReady) {
      this.logger.debug(
        `FCM v1 skipped (${cleanTokens.length} token(s), type=${payload.type}) — configure service account or ADC for live FCM delivery.`,
      );
      return { sent: 0, invalidTokens: [] };
    }

    const stringData: Record<string, string> = {
      type: payload.type,
      titleEn: payload.titleEn,
      titleAr: payload.titleAr,
      bodyEn: payload.bodyEn,
      bodyAr: payload.bodyAr,
    };
    if (payload.data) {
      for (const [k, v] of Object.entries(payload.data)) {
        if (v !== undefined && v !== null) {
          stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
    }

    try {
      const response = await getMessaging(this.app).sendEachForMulticast({
        tokens: cleanTokens,
        notification: {
          title: payload.titleAr || payload.titleEn,
          body: payload.bodyAr || payload.bodyEn,
        },
        data: stringData,
        android: {
          priority: 'high',
          notification: {
            channelId: 'mnis_alerts',
          },
        },
      });

      const invalidTokens: string[] = [];
      response.responses.forEach((res, idx) => {
        if (!res.success && res.error && INVALID_FCM_CODES.has(res.error.code)) {
          invalidTokens.push(cleanTokens[idx]);
        }
      });

      return { sent: response.successCount, invalidTokens };
    } catch (err) {
      this.logger.warn(`FCM v1 delivery failed: ${(err as Error).message}`);
      return { sent: 0, invalidTokens: [] };
    }
  }

  /** Zero-PII live clinic queue counter sync to Firestore (`live_queues/{doctorId}`). */
  async syncLiveQueue(
    doctorId: string,
    facilityEn: string | null | undefined,
    stats: LiveQueueStats,
  ): Promise<void> {
    if (!this.app || !this.firestoreReady || !doctorId) return;
    try {
      await getFirestore(this.app)
        .collection('live_queues')
        .doc(doctorId)
        .set(
          {
            doctorId,
            facilityKey: slugifyFacility(facilityEn),
            currentTicketNo: stats.currentTicketNo ? stats.currentTicketNo.slice(0, 20) : null,
            waitingCount: Math.max(0, Math.trunc(stats.waitingCount)),
            emergencyWaitingCount: Math.max(0, Math.trunc(stats.emergencyWaitingCount)),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (err) {
      this.logger.warn(`Firestore syncLiveQueue skipped: ${(err as Error).message}`);
    }
  }

  /** Zero-PII live ER & bed availability summary sync (`live_er/{facilityKey}`). */
  async syncLiveErSummary(
    facilityEn: string | null | undefined,
    stats: LiveErStats,
  ): Promise<void> {
    if (!this.app || !this.firestoreReady) return;
    const facilityKey = slugifyFacility(facilityEn);
    try {
      await getFirestore(this.app)
        .collection('live_er')
        .doc(facilityKey)
        .set(
          {
            facilityKey,
            availableBeds: Math.max(0, Math.trunc(stats.availableBeds)),
            occupiedBeds: Math.max(0, Math.trunc(stats.occupiedBeds)),
            erWaiting: Math.max(0, Math.trunc(stats.erWaiting)),
            erCritical: Math.max(0, Math.trunc(stats.erCritical)),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (err) {
      this.logger.warn(`Firestore syncLiveErSummary skipped: ${(err as Error).message}`);
    }
  }

  /** Zero-PII user unread notification pulse (`user_signals/{userId}`). */
  async pushUserSignal(userId: string, lastEventType: string, unreadCount: number): Promise<void> {
    if (!this.app || !this.firestoreReady || !userId) return;
    try {
      await getFirestore(this.app)
        .collection('user_signals')
        .doc(userId)
        .set(
          {
            uid: userId,
            lastEventType: lastEventType.slice(0, 64),
            unreadCount: Math.max(0, Math.trunc(unreadCount)),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (err) {
      this.logger.warn(`Firestore pushUserSignal skipped: ${(err as Error).message}`);
    }
  }

  /** Ensures Phone reCAPTCHA Enterprise assessment config is in AUDIT mode for native in-app verification. */
  private async ensurePhoneRecaptchaConfig(): Promise<void> {
    if (!this.app || !this.authReady) return;
    try {
      const pcm = getAuth(this.app).projectConfigManager();
      const cfg = await pcm.getProjectConfig();
      const currentState = cfg.recaptchaConfig?.phoneEnforcementState;
      if (currentState !== 'AUDIT' && currentState !== 'ENFORCE') {
        await pcm.updateProjectConfig({
          recaptchaConfig: {
            phoneEnforcementState: 'AUDIT',
            useSmsBotScore: true,
          },
        });
        this.logger.log('Enabled Firebase Auth Phone reCAPTCHA AUDIT mode for native in-app verification.');
      }
    } catch (err) {
      this.logger.warn(`Could not verify/enable Phone reCAPTCHA config: ${(err as Error).message}`);
    }
  }
}
