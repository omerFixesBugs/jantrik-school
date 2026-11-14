/**
 * The take-attendance link for a section (and a period or a past date). Its own module, so pages
 * that only link to a register (the dashboard, the today page) don't load the section picker.
 */
export const registerHref = (sectionId: string, periodNo = 0, date?: string) => {
  const q = new URLSearchParams({ section: sectionId });
  if (periodNo) q.set('period', String(periodNo));
  if (date) q.set('date', date);
  return `/attendance?${q}`;
};
