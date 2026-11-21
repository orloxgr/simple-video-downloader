import { equal, throws } from "node:assert/strict";
import { scheduleDateTime } from "./live_schedule.ts";

Deno.test("separate date and time fields preserve the computer's local timezone", () => {
  equal(scheduleDateTime("2026-11-20", "21:35", "Start"), new Date(2026, 10, 20, 21, 35).toISOString());
  equal(scheduleDateTime("2026-11-20", "00:00", "Start"), new Date(2026, 10, 20).toISOString());
});

Deno.test("an optional stop time must be either complete or entirely blank", () => {
  equal(scheduleDateTime("", "", "Stop", true), undefined);
  throws(() => scheduleDateTime("2026-11-20", "", "Stop", true), /Stop|stop/);
  throws(() => scheduleDateTime("", "21:00", "Stop", true), /Stop|stop/);
  throws(() => scheduleDateTime("", "", "Start"), /Start|start/);
});

Deno.test("invalid calendar dates and out-of-range time values cannot be normalized silently", () => {
  for (const [date, time] of [
    ["2026-02-29", "12:00"], ["2026-04-31", "12:00"],
    ["2026-11-20", "24:00"], ["2026-11-20", "10:60"],
    ["2026-11-20", "9:05"], ["2026-13-01", "12:00"],
  ]) throws(() => scheduleDateTime(date, time, "Start"));
});

Deno.test("the UI can use the serialized validator without server dependencies", () => {
  const browserVersion = new Function(`return (${scheduleDateTime.toString()});`)();
  equal(browserVersion("2026-11-20", "21:35", "Start"), scheduleDateTime("2026-11-20", "21:35", "Start"));
  throws(() => browserVersion("", "", "Start"));
});
