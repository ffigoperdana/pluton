export type SchedulePreview = {
   timeZone: string;
   legacyTimeZone: boolean;
   nextRunAt: string | null;
   evaluatedAt: string;
   missedRunPolicy: 'skip';
};

export function scheduleSummary(preview: SchedulePreview, active = true): string {
   const zone = preview.timeZone === 'Asia/Jakarta' ? 'Asia/Jakarta (WIB)' : preview.timeZone;
   if (!active) return `Paused · ${zone}`;
   if (!preview.nextRunAt) return `No future calendar slot · ${zone}`;
   const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: preview.timeZone, year: 'numeric', month: 'short', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
   }).format(new Date(preview.nextRunAt));
   return `Next scheduled time: ${formatted} · ${zone}`;
}
