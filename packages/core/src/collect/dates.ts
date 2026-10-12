/** Local calendar dates (the collectors run on the Mac in JST). */
export const DAY_MS = 86_400_000;
export const ymd = (d: Date) => d.toLocaleDateString("sv-SE");
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
