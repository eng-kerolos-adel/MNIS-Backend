require('dotenv/config');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const GOVS = [
  { code: 'CAIRO', en: 'Cairo', ar: 'القاهرة', lat: 30.0444, lng: 31.2357, alias: /cairo|القاهر|maadi|المعادي|nasr|نصر|qasr|قصر|heliopolis|مصر الجديدة|zamalek|الزمالك/i },
  { code: 'GIZA', en: 'Giza', ar: 'الجيزة', lat: 30.0131, lng: 31.2089, alias: /giza|جيز|dokki|الدقي|mohand|مهندس|haram|هرم|october|اكتوبر|zayed|زايد/i },
  { code: 'ALEXANDRIA', en: 'Alexandria', ar: 'الإسكندرية', lat: 31.2001, lng: 29.9187, alias: /alex|اسكندر|إسكندر|smouha|سموحة/i },
  { code: 'LUXOR', en: 'Luxor', ar: 'الأقصر', lat: 25.6872, lng: 32.6396, alias: /luxor|اقصر|أقصر|karnak|الكرنك/i },
  { code: 'ASWAN', en: 'Aswan', ar: 'أسوان', lat: 24.0889, lng: 32.8998, alias: /aswan|اسوان|أسوان/i },
  { code: 'DAKAHLIA', en: 'Dakahlia', ar: 'الدقهلية', lat: 31.0409, lng: 31.3785, alias: /dakahlia|دقهل|mansoura|منصور/i },
  { code: 'SHARKIA', en: 'Sharqia', ar: 'الشرقية', lat: 30.5877, lng: 31.502, alias: /shark|sharq|شرقية|zagazig|زقازيق/i },
  { code: 'GHARBIA', en: 'Gharbia', ar: 'الغربية', lat: 30.7865, lng: 31.0004, alias: /gharb|غربية|tanta|طنطا/i },
  { code: 'QALYUBIA', en: 'Qalyubia', ar: 'القليوبية', lat: 30.4591, lng: 31.1786, alias: /qalyub|قليوب|banha|بنها/i },
];

(async () => {
  const staff = await prisma.user.findMany({
    where: { role: { not: 'PATIENT' } },
    select: {
      id: true,
      role: true,
      facilityEn: true,
      facilityAr: true,
      governorate: true,
      city: true,
      addressAr: true,
      addressEn: true,
      latitude: true,
      longitude: true,
    },
  });

  let updatedCount = 0;
  for (let i = 0; i < staff.length; i++) {
    const u = staff[i];
    if (u.governorate && u.latitude !== null && u.longitude !== null && u.addressAr) {
      continue;
    }
    const facText = `${u.facilityEn || ''} ${u.facilityAr || ''}`;
    let matched = GOVS.find((g) => g.alias.test(facText));
    if (!matched) {
      matched = GOVS[0];
    }

    await prisma.user.update({
      where: { id: u.id },
      data: {
        governorate: u.governorate || matched.code,
        city: u.city || matched.en,
        addressAr: u.addressAr || `${u.facilityAr || 'منشأة المنظومة'} — محافظة ${matched.ar}`,
        addressEn: u.addressEn || `${u.facilityEn || 'MNIS Facility'}, ${matched.en}, Egypt`,
        latitude: u.latitude ?? matched.lat,
        longitude: u.longitude ?? matched.lng,
      },
    });
    updatedCount++;
  }

  console.log(JSON.stringify({ totalStaff: staff.length, backfilled: updatedCount }));
  await prisma.$disconnect();
})();
