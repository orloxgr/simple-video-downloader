// Kept self-contained so the same validation can run in the desktop UI.
export function scheduleDateTime(
  date: string,
  time: string,
  label: string,
  optional = false,
): string | undefined {
  if (optional && !date && !time) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Choose a valid ${label.toLowerCase()} date and time.`);
  }
  const instant = new Date(`${date}T${time}:00`);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (
    !Number.isFinite(instant.getTime()) || instant.getFullYear() !== year ||
    instant.getMonth() + 1 !== month || instant.getDate() !== day ||
    instant.getHours() !== hour || instant.getMinutes() !== minute
  ) {
    throw new Error(`${label} date and time do not exist in your computer timezone.`);
  }
  return instant.toISOString();
}
