import { Injectable } from '@nestjs/common';
import { NotifType, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EGYPT_GOVERNORATES, haversineKm, normalizeGovernorate } from '../common/egypt-geo.util';
import { NotificationsService } from '../notifications/notifications.module';
import { env } from '../config/env';

type SyndromeKey =
  | 'RESPIRATORY_ILI'
  | 'ENTERIC_GI'
  | 'VECTOR_FEBRILE'
  | 'CARDIOMETABOLIC'
  | 'ANTIMICROBIAL_SURGE'
  | 'CRITICAL_ER_SURGE';

const SYNDROMES: Array<{
  key: SyndromeKey;
  ar: string;
  en: string;
  betaPerDay: number;
  gammaPerDay: number;
  icuFraction: number;
}> = [
  { key: 'RESPIRATORY_ILI', ar: 'التهابات الجهاز التنفسي الحادة والإنفلونزا', en: 'Acute Respiratory Illness (ILI)', betaPerDay: 0.34, gammaPerDay: 0.14, icuFraction: 0.045 },
  { key: 'ENTERIC_GI', ar: 'النزلات المعوية والحمى المعوية', en: 'Acute Gastroenteritis & Enteric Cluster', betaPerDay: 0.31, gammaPerDay: 0.17, icuFraction: 0.025 },
  { key: 'VECTOR_FEBRILE', ar: 'الحميات الفيروسية والنواقل', en: 'Vector-Borne & Undifferentiated Febrile Illness', betaPerDay: 0.28, gammaPerDay: 0.15, icuFraction: 0.06 },
  { key: 'CARDIOMETABOLIC', ar: 'الأزمات القلبية والمضاعفات المزمنة', en: 'Cardiometabolic & Chronic Decompensation', betaPerDay: 0.18, gammaPerDay: 0.12, icuFraction: 0.08 },
  { key: 'ANTIMICROBIAL_SURGE', ar: 'تصاعد صرف المضادات الحيوية ومؤشر العدوى', en: 'Broad-Spectrum Antimicrobial Prescribing Surge', betaPerDay: 0.26, gammaPerDay: 0.16, icuFraction: 0.035 },
  { key: 'CRITICAL_ER_SURGE', ar: 'تدفق حالات الطوارئ الحرجة (Acuity 1-2)', en: 'Critical Emergency Acuity Surge', betaPerDay: 0.30, gammaPerDay: 0.15, icuFraction: 0.14 },
];

function classifyClinicalSignal(text: string): SyndromeKey {
  const s = text.toLowerCase();
  if (/resp|cough|pneum|asthma|bronch|flu|influenza|fever|تنفس|صدر|سعال|التهاب رئوي|انفلونزا|ربو|كحة/.test(s)) {
    return 'RESPIRATORY_ILI';
  }
  if (/gastro|diarrh|vomit|enter|stomach|dehydr|معوي|اسهال|قيء|مغص|جفاف/.test(s)) {
    return 'ENTERIC_GI';
  }
  if (/dengue|malaria|vector|rash|hemorrh|حمى|ضنك|نواقل|فيروس/.test(s)) {
    return 'VECTOR_FEBRILE';
  }
  if (/augmentin|amox|azithro|ceftri|cipro|antibiotic|مضاد|أوغمنتين|أزيثرو|سيف/.test(s)) {
    return 'ANTIMICROBIAL_SURGE';
  }
  if (/cardio|hyper|diabet|insulin|angina|stroke|ضغط|سكر|قلب|أنسولين/.test(s)) {
    return 'CARDIOMETABOLIC';
  }
  return 'CRITICAL_ER_SURGE';
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

@Injectable()
export class EpidemiologyEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifs: NotificationsService,
  ) {}

  async computeStrategicForecast(focusGovernorate?: string) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
    const twentyEightDaysAgo = new Date(now.getTime() - 28 * 86_400_000);

    const [patients, prescriptions, erCases, labSamples, visits, beds, drugs, bloodUnits] = await Promise.all([
      this.prisma.patient.findMany({
        select: { id: true, governorate: true, chronicConditions: true, createdAt: true },
      }),
      this.prisma.prescription.findMany({
        where: { status: { not: 'DRAFT' } },
        select: { id: true, patientId: true, diagnosisEn: true, diagnosisAr: true, createdAt: true, items: { select: { nameEn: true, nameAr: true } } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      this.prisma.erCase.findMany({
        select: { id: true, patientId: true, acuity: true, complaintEn: true, complaintAr: true, arrivedAt: true, status: true },
        orderBy: { arrivedAt: 'desc' },
        take: 500,
      }),
      this.prisma.labSample.findMany({
        select: { id: true, patientId: true, panelEn: true, panelAr: true, priority: true, collectedAt: true, results: { select: { flag: true } } },
        orderBy: { collectedAt: 'desc' },
        take: 600,
      }),
      this.prisma.visit.findMany({
        select: { id: true, patientId: true, reasonEn: true, reasonAr: true, isEmergency: true, arrivedAt: true },
        orderBy: { arrivedAt: 'desc' },
        take: 600,
      }),
      this.prisma.bed.findMany({ select: { status: true, acuity: true } }),
      this.prisma.drugInventory.findMany({ select: { nameEn: true, nameAr: true, quantity: true, reorderAt: true } }),
      this.prisma.bloodUnit.count({ where: { status: 'AVAILABLE' } }),
    ]);

    const patientGovMap = new Map<string, string>();
    for (const p of patients) {
      const code = normalizeGovernorate(p.governorate) ?? 'CAIRO';
      patientGovMap.set(p.id, code);
    }

    type GovBucket = {
      code: string;
      en: string;
      ar: string;
      lat: number;
      lng: number;
      citizens: number;
      recent7d: number;
      baseline21d: number;
      totalSignals: number;
      criticalSignals: number;
      syndromeCounts: Record<SyndromeKey, number>;
    };

    const buckets = new Map<string, GovBucket>();
    for (const g of EGYPT_GOVERNORATES) {
      buckets.set(g.code, {
        code: g.code,
        en: g.en,
        ar: g.ar,
        lat: g.lat,
        lng: g.lng,
        citizens: 0,
        recent7d: 0,
        baseline21d: 0,
        totalSignals: 0,
        criticalSignals: 0,
        syndromeCounts: {
          RESPIRATORY_ILI: 0,
          ENTERIC_GI: 0,
          VECTOR_FEBRILE: 0,
          CARDIOMETABOLIC: 0,
          ANTIMICROBIAL_SURGE: 0,
          CRITICAL_ER_SURGE: 0,
        },
      });
    }

    const addSignal = (patientId: string, dt: Date, text: string, weight = 1, isCritical = false) => {
      const govCode = patientGovMap.get(patientId) ?? 'CAIRO';
      const b = buckets.get(govCode);
      if (!b) return;
      const syn = classifyClinicalSignal(text);
      b.syndromeCounts[syn] += weight;
      b.totalSignals += weight;
      if (isCritical) b.criticalSignals += weight;
      if (dt >= sevenDaysAgo) b.recent7d += weight;
      else if (dt >= twentyEightDaysAgo) b.baseline21d += weight;
    };

    for (const p of patients) {
      const b = buckets.get(patientGovMap.get(p.id) ?? 'CAIRO');
      if (b) b.citizens++;
    }
    for (const rx of prescriptions) {
      const itemTxt = rx.items.map((i) => `${i.nameEn} ${i.nameAr}`).join(' ');
      addSignal(rx.patientId, rx.createdAt, `${rx.diagnosisEn} ${rx.diagnosisAr} ${itemTxt}`, 1.2, false);
    }
    for (const er of erCases) {
      addSignal(er.patientId, er.arrivedAt, `${er.complaintEn} ${er.complaintAr}`, er.acuity <= 2 ? 2.5 : 1.5, er.acuity <= 2);
    }
    for (const ls of labSamples) {
      const hasCritical = ls.results.some((r) => r.flag === 'CRITICAL' || r.flag === 'HIGH');
      addSignal(ls.patientId, ls.collectedAt, `${ls.panelEn} ${ls.panelAr}`, hasCritical ? 2 : 1, hasCritical);
    }
    for (const v of visits) {
      addSignal(v.patientId, v.arrivedAt, `${v.reasonEn} ${v.reasonAr}`, v.isEmergency ? 2 : 1, v.isEmergency);
    }

    const totalBeds = beds.length || 1;
    const occupiedBeds = beds.filter((b) => b.status === 'OCCUPIED').length;
    const bedOccupancyPct = Number(((occupiedBeds / totalBeds) * 100).toFixed(1));
    const lowStockDrugs = drugs.filter((d) => d.quantity <= d.reorderAt);
    const supplyStressPct = drugs.length > 0 ? Number(((lowStockDrugs.length / drugs.length) * 100).toFixed(1)) : 0;

    // Layer 2 & 3: EARS-C2 Z-score, CUSUM anomaly, Rt effective reproduction number & NORI
    const serialIntervalTau = 4.2;
    const regions = Array.from(buckets.values())
      .filter((b) => b.citizens > 0 || b.totalSignals > 0)
      .map((b) => {
        const baselineWeekly = b.baseline21d > 0 ? b.baseline21d / 3 : Math.max(1.2, b.citizens * 0.45);
        const baselineStd = Math.max(1.1, Math.sqrt(baselineWeekly));
        const recent = Math.max(0, b.recent7d);
        const zScore = Number(((recent - baselineWeekly) / baselineStd).toFixed(2));
        const cusum = Number(Math.max(0, recent - baselineWeekly - 0.5 * baselineStd).toFixed(2));

        const dailyRecent = recent / 7;
        const dailyPrev = baselineWeekly / 7;
        const growthRateR = dailyPrev > 0 ? Math.log((dailyRecent + 0.5) / (dailyPrev + 0.5)) / 7 : 0;
        const effectiveRt = Number(clamp(Math.exp(growthRateR * serialIntervalTau), 0.72, 2.45).toFixed(2));

        let topSyndrome = SYNDROMES[0];
        let topVal = -1;
        for (const s of SYNDROMES) {
          if (b.syndromeCounts[s.key] > topVal) {
            topVal = b.syndromeCounts[s.key];
            topSyndrome = s;
          }
        }

        const rawRisk =
          clamp((zScore + 1) * 18, 0, 42) +
          clamp((effectiveRt - 0.85) * 38, 0, 32) +
          clamp(b.criticalSignals * 4.5, 0, 14) +
          clamp(bedOccupancyPct * 0.08 + supplyStressPct * 0.06, 0, 12);
        const riskScore = Math.round(clamp(rawRisk, 8, 98));
        const alertLevel =
          riskScore >= 72 || zScore >= 2.5
            ? 'CRITICAL'
            : riskScore >= 48 || zScore >= 1.4
              ? 'WATCH'
              : 'NORMAL';

        // Discrete 14-day SEIR simulation seeded from live governorate metrics
        const N = Math.max(25000, b.citizens * 5000);
        const effBeta = topSyndrome.betaPerDay * clamp(effectiveRt / 1.15, 0.75, 1.85);
        const sigma = 1 / 3.2; // incubation rate (~3.2 days)
        const gamma = topSyndrome.gammaPerDay;
        let S = N - Math.max(12, Math.round(recent * 8 + b.citizens * 2));
        let E = Math.max(6, Math.round(recent * 4 + 6));
        let I = Math.max(8, Math.round(recent * 5 + 8));
        let R = 0;

        const seir14d: Array<{
          day: number;
          dateLabel: string;
          exposed: number;
          infectious: number;
          cumulativeCases: number;
          projectedIcuNeed: number;
        }> = [];
        for (let day = 0; day <= 14; day++) {
          const dLabel = new Date(now.getTime() + day * 86_400_000).toISOString().slice(5, 10);
          seir14d.push({
            day,
            dateLabel: dLabel,
            exposed: Math.round(E),
            infectious: Math.round(I),
            cumulativeCases: Math.round(I + R),
            projectedIcuNeed: Math.max(1, Math.round(I * topSyndrome.icuFraction)),
          });
          const newExposed = (effBeta * S * I) / N;
          const newInfectious = sigma * E;
          const newRecovered = gamma * I;
          S = Math.max(0, S - newExposed);
          E = Math.max(0, E + newExposed - newInfectious);
          I = Math.max(0, I + newInfectious - newRecovered);
          R += newRecovered;
        }

        return {
          code: b.code,
          en: b.en,
          ar: b.ar,
          lat: b.lat,
          lng: b.lng,
          citizensCount: b.citizens,
          recent7dSignals: Number(recent.toFixed(1)),
          baselineWeekly: Number(baselineWeekly.toFixed(1)),
          zScore,
          cusumScore: cusum,
          effectiveRt,
          riskScore,
          alertLevel,
          dominantSyndrome: {
            key: topSyndrome.key,
            ar: topSyndrome.ar,
            en: topSyndrome.en,
          },
          projectedDay14Active: seir14d[14]?.infectious ?? 0,
          projectedDay14Icu: seir14d[14]?.projectedIcuNeed ?? 0,
          seir14d,
        };
      })
      .sort((a, b) => b.riskScore - a.riskScore);

    // Layer 4: Spatial Gravity Spillover Corridors between active regions
    const spilloverCorridors: Array<{
      fromCode: string;
      fromAr: string;
      fromEn: string;
      toCode: string;
      toAr: string;
      toEn: string;
      distanceKm: number;
      spilloverIndex: number;
    }> = [];

    const topSources = regions.slice(0, Math.min(5, regions.length));
    for (const src of topSources) {
      for (const dst of EGYPT_GOVERNORATES) {
        if (dst.code === src.code) continue;
        const dKm = haversineKm(src.lat, src.lng, dst.lat, dst.lng);
        if (dKm > 380) continue;
        const gravity = ((src.riskScore * Math.max(1, src.recent7dSignals + 4)) / Math.pow(dKm + 25, 1.35)) * 100;
        spilloverCorridors.push({
          fromCode: src.code,
          fromAr: src.ar,
          fromEn: src.en,
          toCode: dst.code,
          toAr: dst.ar,
          toEn: dst.en,
          distanceKm: Math.round(dKm),
          spilloverIndex: Number(gravity.toFixed(2)),
        });
      }
    }
    spilloverCorridors.sort((a, b) => b.spilloverIndex - a.spilloverIndex);

    // Global aggregate syndrome distribution
    const syndromeTotals = SYNDROMES.map((s) => {
      const count = Array.from(buckets.values()).reduce((sum, b) => sum + b.syndromeCounts[s.key], 0);
      return { key: s.key, ar: s.ar, en: s.en, count: Number(count.toFixed(1)) };
    }).sort((a, b) => b.count - a.count);

    const nationalRiskIndex = regions.length
      ? Math.round(regions.slice(0, 4).reduce((s, r) => s + r.riskScore, 0) / Math.min(4, regions.length))
      : 18;
    const meanRt = regions.length
      ? Number((regions.reduce((s, r) => s + r.effectiveRt, 0) / regions.length).toFixed(2))
      : 0.95;

    const focusedNorm = normalizeGovernorate(focusGovernorate);
    const focusRegion =
      (focusedNorm ? regions.find((r) => r.code === focusedNorm) : null) ?? regions[0] ?? null;

    const topAlertRegion = regions[0] ?? { code: 'CAIRO', ar: 'القاهرة', en: 'Cairo', riskScore: 22, effectiveRt: 1.02, zScore: 0.9, dominantSyndrome: SYNDROMES[0] };

    const directives = [
      {
        priority: topAlertRegion.riskScore >= 60 ? 'CRITICAL' : 'HIGH',
        targetGovernorate: topAlertRegion.code,
        titleAr: `تعزيز الترصد الوبائي والاستعداد السريري في ${topAlertRegion.ar}`,
        titleEn: `Elevate Epidemiological Readiness in ${topAlertRegion.en}`,
        rationaleAr: `مؤشر الخطورة المركب (${topAlertRegion.riskScore}/100) مع معامل تكاثر لحظي Rt=${topAlertRegion.effectiveRt} وتصدر متلازمة (${topAlertRegion.dominantSyndrome.ar}).`,
        rationaleEn: `Composite risk index ${topAlertRegion.riskScore}/100 with Rt=${topAlertRegion.effectiveRt} led by ${topAlertRegion.dominantSyndrome.en}.`,
        actionAr: 'تفعيل فرق التدخل السريع، رفع سحب العينات المعملية التأكيدية، ومراقبة إشغال العناية المركزة يومياً.',
        actionEn: 'Deploy rapid response clinics, step up confirmatory lab sampling, and audit ICU buffer capacity daily.',
      },
      {
        priority: lowStockDrugs.length > 0 ? 'HIGH' : 'NORMAL',
        targetGovernorate: 'NATIONAL',
        titleAr: lowStockDrugs.length > 0 ? `أمر إمداد دوائي عاجل لـ ${lowStockDrugs.length} صنف منخفض الرصيد` : 'تحصين المخزون الدوائي الاستراتيجي لمدة 90 يوماً',
        titleEn: lowStockDrugs.length > 0 ? `Urgent Drug Replenishment for ${lowStockDrugs.length} Low-Stock Item(s)` : 'Maintain 90-Day Strategic Medical Buffer',
        rationaleAr: `رصد ${lowStockDrugs.length} صنف تحت حد الأمان الدوائي بنسبة ضغط إمداد ${supplyStressPct}%، بالتوازي مع إشغال أسرة ${bedOccupancyPct}%.`,
        rationaleEn: `${lowStockDrugs.length} inventory item(s) below reorder threshold (${supplyStressPct}% stress); national bed occupancy at ${bedOccupancyPct}%.`,
        actionAr: 'إعادة توزيع الحصص الدوائية ومضادات العدوى إلى المحافظات الأعلى خطورة قبل ذروة اليوم الـ14.',
        actionEn: 'Reallocate antimicrobial and critical care stocks toward highest-Rt governorates ahead of Day-14 peak.',
      },
    ];

    return {
      generatedAt: now.toISOString(),
      modelSignature: {
        nameEn: 'MNIS-SEIR + EARS-C2 + Spatial Gravity Hybrid Engine v2.0',
        nameAr: 'محرك MNIS الهجين للتنبؤ الوبائي (SEIR + CUSUM/Z-Score + Spatial Gravity v2.0)',
        layers: [
          '1) Multi-Source Clinical NLP & Syndromic Classifier (Rx + ER + Lab + Visits)',
          '2) EARS C2 Adaptive Moving-Baseline & CUSUM Anomaly Detection (7d vs 28d)',
          '3) Serial-Interval Effective Reproduction Estimator (Rt = e^(r·4.2d))',
          '4) Discrete 14-Day Compartmental SEIR Outbreak Progression Simulator',
          '5) Haversine Inter-Governorate Spatial Gravity Spillover Model',
        ],
      },
      nationalSummary: {
        nationalRiskIndex,
        meanRt,
        bedOccupancyPct,
        occupiedBeds,
        totalBeds,
        availableBloodUnits: bloodUnits,
        lowStockDrugsCount: lowStockDrugs.length,
        supplyStressPct,
        totalPatientsAnalyzed: patients.length,
        totalSignalsAnalyzed: prescriptions.length + erCases.length + labSamples.length + visits.length,
      },
      focusRegion,
      regions,
      syndromeTotals,
      spilloverCorridors: spilloverCorridors.slice(0, 8),
      lowStockDrugs: lowStockDrugs.slice(0, 6),
      directives,
    };
  }

  async askStrategicAssistant(prompt: string, locale: 'ar' | 'en' = 'ar', focusGovernorate?: string) {
    const forecast = await this.computeStrategicForecast(focusGovernorate);
    const q = prompt.trim();
    const isAr = locale === 'ar';
    const top = forecast.regions[0];
    const corridor = forecast.spilloverCorridors[0];
    const topSyn = forecast.syndromeTotals[0];

    let answerAr = [
      `📊 **التحليل الاستراتيجي الفوري لوزارة الصحة (مؤشر الخطورة القومي: ${forecast.nationalSummary.nationalRiskIndex}/100 | Rt = ${forecast.nationalSummary.meanRt})**`,
      top
        ? `• **أعلى بؤرة مرصودة حالياً:** محافظة **${top.ar}** (درجة الخطورة: ${top.riskScore}/100، Z-Score = ${top.zScore}، معامل الانتشار Rt = ${top.effectiveRt}). المتلازمة السائدة هي **${top.dominantSyndrome.ar}**، ومن المتوقع وصول الحالات النشطة بالمحاكاة خلال 14 يوماً إلى نحو **${top.projectedDay14Active}** حالة تتطلب قرابة **${top.projectedDay14Icu}** سرير عناية حرجة.`
        : '• جميع المحافظات حالياً ضمن النطاق الوبائي المستقر.',
      topSyn
        ? `• **الاتجاه الوبائي السائد على مستوى الجمهورية:** تتصدر **${topSyn.ar}** بوزن إشارات سريرية (${topSyn.count}) مستخلصة من الروشتات والطوارئ والتحاليل الحرجة.`
        : '',
      corridor
        ? `• **ممر الانتشار الجغرافي الأعلى (Spatial Gravity):** احتمالية انتقال العدوى الأعلى مرصودة من **${corridor.fromAr}** إلى **${corridor.toAr}** (المسافة ${corridor.distanceKm} كم — مؤشر التدفق ${corridor.spilloverIndex}).`
        : '',
      `• **الجاهزية السريرية والإمداد الدوائي:** إشغال الأسرة القومي **${forecast.nationalSummary.bedOccupancyPct}%** (${forecast.nationalSummary.occupiedBeds}/${forecast.nationalSummary.totalBeds})، أرصدة بنك الدم المتاحة **${forecast.nationalSummary.availableBloodUnits}** كيس، ويوجد **${forecast.nationalSummary.lowStockDrugsCount}** صنف دوائي عند حد إعادة الطلب.`,
      `✅ **التوصية التنفيذية المباشرة للمساعد الشخصي:** ${forecast.directives[0]?.titleAr ?? ''} — ${forecast.directives[0]?.actionAr ?? ''}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let answerEn = [
      `📊 **MoHP Live Strategic Briefing (National Outbreak Risk Index: ${forecast.nationalSummary.nationalRiskIndex}/100 | Mean Rt = ${forecast.nationalSummary.meanRt})**`,
      top
        ? `• **Highest Priority Hotspot:** **${top.en}** (Risk ${top.riskScore}/100, Z=${top.zScore}, Rt=${top.effectiveRt}). Dominant syndrome: **${top.dominantSyndrome.en}**. 14-day SEIR projection indicates ~**${top.projectedDay14Active}** active cases requiring ~**${top.projectedDay14Icu}** ICU beds.`
        : '• All governorates currently fall inside baseline endemic tolerance.',
      corridor
        ? `• **Primary Spatial Spillover Corridor:** Highest inter-governorate transmission gravity runs from **${corridor.fromEn}** to **${corridor.toEn}** (${corridor.distanceKm} km, Gravity Index ${corridor.spilloverIndex}).`
        : '',
      `• **Hospital & Supply Readiness:** Bed occupancy **${forecast.nationalSummary.bedOccupancyPct}%**, available blood units **${forecast.nationalSummary.availableBloodUnits}**, low-stock drugs flagged: **${forecast.nationalSummary.lowStockDrugsCount}**.`,
      `✅ **Recommended Executive Action:** ${forecast.directives[0]?.titleEn ?? ''} — ${forecast.directives[0]?.actionEn ?? ''}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Optional live Gemini synthesis when GEMINI_API_KEY is configured cleanly on server
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (apiKey && q.length > 0) {
      try {
        const contextPayload = JSON.stringify({
          nationalSummary: forecast.nationalSummary,
          topRegions: forecast.regions.slice(0, 5).map((r) => ({
            ar: r.ar,
            en: r.en,
            riskScore: r.riskScore,
            zScore: r.zScore,
            rt: r.effectiveRt,
            syndromeAr: r.dominantSyndrome.ar,
            day14Active: r.projectedDay14Active,
            day14Icu: r.projectedDay14Icu,
          })),
          corridors: forecast.spilloverCorridors.slice(0, 3),
          lowStockDrugs: forecast.lowStockDrugs.map((d) => d.nameAr),
        });
        const sysPrompt = isAr
          ? 'أنت المستشار الاستراتيجي الشخصي لوزير الصحة في منظومة MNIS. اعتمد حصراً على الأرقام الحقيقية الممررة من محرك SEIR وCUSUM والجاذبية المكانية واكتب إجابة تنفيذية مركزة واحترافية باللغة العربية مع خطوات عملية واضحة.'
          : 'You are the Personal Strategic Advisor for the Ministry of Health on MNIS. Ground your concise executive answer strictly in the live SEIR/CUSUM/Gravity telemetry JSON provided.';
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: sysPrompt }] },
              contents: [{ parts: [{ text: `Question: ${q}\nLive Epidemiological Telemetry: ${contextPayload}` }] }],
              generationConfig: { temperature: 0.25, maxOutputTokens: 900 },
            }),
          },
        );
        if (geminiRes.ok) {
          const json = (await geminiRes.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const gemText = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (gemText) {
            if (isAr) answerAr = gemText;
            else answerEn = gemText;
          }
        }
      } catch {
        /* keep deterministic 5-layer engine response seamlessly */
      }
    }

    return {
      question: q,
      answeredAt: new Date().toISOString(),
      answer: isAr ? answerAr : answerEn,
      answerAr,
      answerEn,
      telemetrySnapshot: forecast.nationalSummary,
      topHotspots: forecast.regions.slice(0, 4),
      corridors: forecast.spilloverCorridors.slice(0, 4),
    };
  }

  async broadcastStrategicDirective(input: {
    governorate: string;
    severity: 'ELEVATED' | 'CRITICAL';
    titleAr: string;
    titleEn: string;
    messageAr: string;
    messageEn: string;
  }) {
    await this.notifs.notifyRoles(
      [Role.HOSPITAL_STAFF, Role.DOCTOR, Role.ADMIN, Role.PHARMACIST],
      NotifType.EMERGENCY_ALERT,
      `MoHP Strategic Directive (${input.severity}) — ${input.titleEn}`,
      `توجيه استراتيجي من وزارة الصحة (${input.severity === 'CRITICAL' ? 'حرج' : 'عاجل'}) — ${input.titleAr}`,
      `[${input.governorate}] ${input.messageEn}`,
      `[نطاق: ${input.governorate}] ${input.messageAr}`,
      {
        category: 'MINISTRY_DIRECTIVE',
        severity: input.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        governorate: input.governorate,
        href: '/analytics/ai-strategist',
      },
    );
    return { ok: true, dispatchedAt: new Date().toISOString() };
  }
}
