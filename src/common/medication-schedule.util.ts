export interface ParsedMedicationSchedule {
  timesPerDay: number;
  intervalHours: number;
  scheduleTimes: string[];
  startsAt: Date;
  endsAt: Date;
}

/**
 * Parses bilingual clinical dosage frequency strings (e.g. "كل 8 ساعات", "Twice daily", "1x3")
 * into structured daily alarm times (`HH:MM`) and start/end dates.
 */
export function parseMedicationSchedule(
  frequencyEn: string,
  frequencyAr: string,
  durationDays: number,
  dispensedAt: Date = new Date(),
): ParsedMedicationSchedule {
  const txt = `${frequencyEn ?? ''} ${frequencyAr ?? ''}`.toLowerCase();
  const safeDays = Math.max(1, Math.min(365, Math.trunc(durationDays || 7)));

  let timesPerDay = 1;
  let intervalHours = 24;
  let scheduleTimes: string[] = ['09:00'];

  if (/every\s*4|q4h|كل\s*4|كل\s*أربع|6\s*times|6\s*مرات|1\s*[x×]\s*6/i.test(txt)) {
    timesPerDay = 6;
    intervalHours = 4;
    scheduleTimes = ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'];
  } else if (/every\s*6|q6h|qid|كل\s*6|كل\s*ست|4\s*times|4\s*مرات|أربع\s*مرات|1\s*[x×]\s*4/i.test(txt)) {
    timesPerDay = 4;
    intervalHours = 6;
    scheduleTimes = ['06:00', '12:00', '18:00', '00:00'];
  } else if (/every\s*8|q8h|tid|كل\s*8|كل\s*ثمان|3\s*times|3\s*مرات|ثلاث\s*مرات|1\s*[x×]\s*3/i.test(txt)) {
    timesPerDay = 3;
    intervalHours = 8;
    scheduleTimes = ['08:00', '16:00', '00:00'];
  } else if (/every\s*12|q12h|bid|twice|كل\s*12|مرتين|صباحا\s*ومساء|صباحاً\s*ومساءً|1\s*[x×]\s*2/i.test(txt)) {
    timesPerDay = 2;
    intervalHours = 12;
    scheduleTimes = ['09:00', '21:00'];
  } else if (/bedtime|qhs|at night|قبل النوم|مساءً|بالليل/i.test(txt)) {
    timesPerDay = 1;
    intervalHours = 24;
    scheduleTimes = ['22:00'];
  } else if (/breakfast|empty stomach|morning|على الريق|قبل الإفطار|قبل الفطار|صباحاً/i.test(txt)) {
    timesPerDay = 1;
    intervalHours = 24;
    scheduleTimes = ['07:30'];
  }

  const startsAt = new Date(dispensedAt);
  const endsAt = new Date(startsAt.getTime() + safeDays * 86_400_000);

  return {
    timesPerDay,
    intervalHours,
    scheduleTimes,
    startsAt,
    endsAt,
  };
}
