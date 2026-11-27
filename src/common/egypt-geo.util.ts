export interface GovernorateMeta {
  code: string;
  en: string;
  ar: string;
  lat: number;
  lng: number;
  aliases: string[];
}

export const EGYPT_GOVERNORATES: GovernorateMeta[] = [
  {
    code: 'CAIRO',
    en: 'Cairo',
    ar: 'القاهرة',
    lat: 30.0444,
    lng: 31.2357,
    aliases: [
      'cairo', 'القاهرة', 'القاهره', 'maadi', 'المعادي', 'nasr city', 'مدينة نصر',
      'heliopolis', 'مصر الجديدة', 'zamalek', 'الزمالك', 'qasr el-ainy', 'qasr el ainy',
      'قصر العيني', 'el-kasr', 'downtown', 'وسط البلد', 'shubra', 'شبرا', 'new cairo',
      'التجمع', 'helwan', 'حلوان', 'ain shams', 'عين شمس', 'dar el-fouad',
    ],
  },
  {
    code: 'GIZA',
    en: 'Giza',
    ar: 'الجيزة',
    lat: 30.0131,
    lng: 31.2089,
    aliases: [
      'giza', 'الجيزة', 'الجيزه', 'dokki', 'الدقي', 'mohandessin', 'المهندسين',
      'agouza', 'العجوزة', 'haram', 'الهرم', 'october', '6th of october', 'أكتوبر',
      'sheikh zayed', 'الشيخ زايد', 'faisal', 'فيصل',
    ],
  },
  {
    code: 'ALEXANDRIA',
    en: 'Alexandria',
    ar: 'الإسكندرية',
    lat: 31.2001,
    lng: 29.9187,
    aliases: [
      'alexandria', 'alex', 'الإسكندرية', 'الاسكندرية', 'الاسكندريه', 'smouha', 'سموحة',
      'sidi gaber', 'سيدي جابر', 'gleem', 'stanley', 'miami', 'ميامي', 'montaza', 'المنتزه',
      'borg el arab', 'برج العرب',
    ],
  },
  {
    code: 'QALYUBIA',
    en: 'Qalyubia',
    ar: 'القليوبية',
    lat: 30.4591,
    lng: 31.1786,
    aliases: ['qalyubia', 'kalyoubia', 'القليوبية', 'بنها', 'banha', 'shubra el-kheima', 'شبرا الخيمة', 'qalyub', 'قليوب'],
  },
  {
    code: 'SHARKIA',
    en: 'Sharqia',
    ar: 'الشرقية',
    lat: 30.5877,
    lng: 31.502,
    aliases: ['sharqia', 'sharkia', 'الشرقية', 'الشرقيه', 'zagazig', 'الزقازيق', '10th of ramadan', 'العاشر من رمضان', 'bilbeis'],
  },
  {
    code: 'DAKAHLIA',
    en: 'Dakahlia',
    ar: 'الدقهلية',
    lat: 31.0409,
    lng: 31.3785,
    aliases: ['dakahlia', 'الدقهلية', 'الدقهليه', 'mansoura', 'المنصورة', 'talkha', 'طلخا', 'mit ghamr'],
  },
  {
    code: 'GHARBIA',
    en: 'Gharbia',
    ar: 'الغربية',
    lat: 30.7865,
    lng: 31.0004,
    aliases: ['gharbia', 'الغربية', 'الغربيه', 'tanta', 'طنطا', 'mahalla', 'المحلة الكبرى', 'kafr el zayat'],
  },
  {
    code: 'MONUFIA',
    en: 'Monufia',
    ar: 'المنوفية',
    lat: 30.5503,
    lng: 31.0106,
    aliases: ['monufia', 'menoufia', 'المنوفية', 'المنوفيه', 'shibin el kom', 'شبين الكوم', 'sadat', 'السادات'],
  },
  {
    code: 'BEHEIRA',
    en: 'Beheira',
    ar: 'البحيرة',
    lat: 31.042,
    lng: 30.469,
    aliases: ['beheira', 'البحيرة', 'البحيره', 'damanhour', 'دمنهور', 'kafr el dawwar'],
  },
  {
    code: 'KAFR_EL_SHEIKH',
    en: 'Kafr El Sheikh',
    ar: 'كفر الشيخ',
    lat: 31.1107,
    lng: 30.9388,
    aliases: ['kafr el sheikh', 'kafr el-sheikh', 'كفر الشيخ', 'desouk', 'دسوق'],
  },
  {
    code: 'DAMIETTA',
    en: 'Damietta',
    ar: 'دمياط',
    lat: 31.4175,
    lng: 31.8144,
    aliases: ['damietta', 'دمياط', 'new damietta', 'دمياط الجديدة', 'ras el bar'],
  },
  {
    code: 'PORT_SAID',
    en: 'Port Said',
    ar: 'بورسعيد',
    lat: 31.2653,
    lng: 32.3019,
    aliases: ['port said', 'portsaid', 'بورسعيد', 'بورفؤاد'],
  },
  {
    code: 'ISMAILIA',
    en: 'Ismailia',
    ar: 'الإسماعيلية',
    lat: 30.5965,
    lng: 32.2715,
    aliases: ['ismailia', 'الإسماعيلية', 'الاسماعيلية', 'fayed'],
  },
  {
    code: 'SUEZ',
    en: 'Suez',
    ar: 'السويس',
    lat: 29.9668,
    lng: 32.5498,
    aliases: ['suez', 'السويس', 'ain sokhna'],
  },
  {
    code: 'FAYOUM',
    en: 'Faiyum',
    ar: 'الفيوم',
    lat: 29.3084,
    lng: 30.8428,
    aliases: ['fayoum', 'faiyum', 'الفيوم'],
  },
  {
    code: 'BENI_SUEF',
    en: 'Beni Suef',
    ar: 'بني سويف',
    lat: 29.0661,
    lng: 31.0994,
    aliases: ['beni suef', 'beni-suef', 'بني سويف'],
  },
  {
    code: 'MINYA',
    en: 'Minya',
    ar: 'المنيا',
    lat: 28.0871,
    lng: 30.7618,
    aliases: ['minya', 'المنيا', 'mallawi', 'ملوي'],
  },
  {
    code: 'ASYUT',
    en: 'Asyut',
    ar: 'أسيوط',
    lat: 27.1783,
    lng: 31.1859,
    aliases: ['asyut', 'assiut', 'أسيوط', 'اسيوط'],
  },
  {
    code: 'SOHAG',
    en: 'Sohag',
    ar: 'سوهاج',
    lat: 26.5591,
    lng: 31.6957,
    aliases: ['sohag', 'سوهاج', 'akhmim', 'أخميم'],
  },
  {
    code: 'QENA',
    en: 'Qena',
    ar: 'قنا',
    lat: 26.1551,
    lng: 32.716,
    aliases: ['qena', 'قنا', 'nag hammadi', 'نجع حمادي'],
  },
  {
    code: 'LUXOR',
    en: 'Luxor',
    ar: 'الأقصر',
    lat: 25.6872,
    lng: 32.6396,
    aliases: ['luxor', 'الأقصر', 'الاقصر', 'karnak', 'الكرنك', 'armant', 'أرمنت', 'esna', 'إسنا'],
  },
  {
    code: 'ASWAN',
    en: 'Aswan',
    ar: 'أسوان',
    lat: 24.0889,
    lng: 32.8998,
    aliases: ['aswan', 'أسوان', 'اسوان', 'kom ombo', 'edfu', 'إدفو'],
  },
  {
    code: 'RED_SEA',
    en: 'Red Sea',
    ar: 'البحر الأحمر',
    lat: 27.2579,
    lng: 33.8116,
    aliases: ['red sea', 'hurghada', 'البحر الأحمر', 'الغردقة', 'el gouna', 'marsa alam', 'safaga'],
  },
  {
    code: 'NEW_VALLEY',
    en: 'New Valley',
    ar: 'الوادي الجديد',
    lat: 25.439,
    lng: 30.5586,
    aliases: ['new valley', 'الوادي الجديد', 'kharga', 'الخارجة', 'dakhla'],
  },
  {
    code: 'MATROUH',
    en: 'Matrouh',
    ar: 'مطروح',
    lat: 31.3543,
    lng: 27.2373,
    aliases: ['matrouh', 'marsa matrouh', 'مطروح', 'مرسى مطروح', 'alamein', 'العلمين'],
  },
  {
    code: 'NORTH_SINAI',
    en: 'North Sinai',
    ar: 'شمال سيناء',
    lat: 31.1321,
    lng: 33.8033,
    aliases: ['north sinai', 'شمال سيناء', 'arish', 'el arish', 'العريش'],
  },
  {
    code: 'SOUTH_SINAI',
    en: 'South Sinai',
    ar: 'جنوب سيناء',
    lat: 27.9158,
    lng: 34.3299,
    aliases: ['south sinai', 'جنوب سيناء', 'sharm', 'sharm el sheikh', 'شرم الشيخ', 'dahab', 'دهب', 'tor'],
  },
];

function cleanGeoText(s?: string | null): string {
  return (s ?? '')
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '')
    .toLowerCase();
}

export function normalizeGovernorate(raw?: string | null): string | null {
  const cleaned = cleanGeoText(raw);
  if (!cleaned) return null;

  for (const g of EGYPT_GOVERNORATES) {
    if (g.code.toLowerCase() === cleaned || cleanGeoText(g.en) === cleaned || cleanGeoText(g.ar) === cleaned) {
      return g.code;
    }
    if (g.aliases.some((a) => cleaned === cleanGeoText(a))) {
      return g.code;
    }
  }

  for (const g of EGYPT_GOVERNORATES) {
    if (g.aliases.some((a) => cleaned.includes(cleanGeoText(a)))) {
      return g.code;
    }
  }
  return null;
}

export function getGovernorateMeta(codeOrName?: string | null): GovernorateMeta | null {
  const code = normalizeGovernorate(codeOrName);
  if (!code) return null;
  return EGYPT_GOVERNORATES.find((g) => g.code === code) ?? null;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

export function resolveGovernorateFromCoords(lat: number, lng: number): {
  code: string;
  en: string;
  ar: string;
  distanceKm: number;
  centroidLat: number;
  centroidLng: number;
} {
  let best = EGYPT_GOVERNORATES[0];
  let bestDist = Infinity;
  for (const g of EGYPT_GOVERNORATES) {
    const d = haversineKm(lat, lng, g.lat, g.lng);
    if (d < bestDist) {
      bestDist = d;
      best = g;
    }
  }
  return {
    code: best.code,
    en: best.en,
    ar: best.ar,
    distanceKm: bestDist,
    centroidLat: best.lat,
    centroidLng: best.lng,
  };
}

export function inferLocationFromFacilityText(
  facilityEn?: string | null,
  facilityAr?: string | null,
): {
  governorate: string;
  city: string;
  addressEn: string;
  addressAr: string;
  latitude: number;
  longitude: number;
} {
  const combined = `${facilityEn ?? ''} ${facilityAr ?? ''}`.trim();
  const normCode = normalizeGovernorate(combined) ?? 'CAIRO';
  const meta = getGovernorateMeta(normCode) ?? EGYPT_GOVERNORATES[0];
  return {
    governorate: meta.code,
    city: meta.en,
    addressEn: facilityEn?.trim() ? `${facilityEn.trim()}, ${meta.en}, Egypt` : `${meta.en}, Egypt`,
    addressAr: facilityAr?.trim() ? `${facilityAr.trim()} — ${meta.ar}` : `${meta.ar}، مصر`,
    latitude: meta.lat,
    longitude: meta.lng,
  };
}
