import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { LiveManager, liveRequest, liveSource } from "./live.ts";

const target =
  "https://www.hellasnews.tv/live/?position=8&showheader=1&showfooter=1";
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check: () => boolean) {
  for (let count = 0; count < 400; count++) {
    if (check()) return;
    await pause();
  }
  throw new Error("Timed out waiting for live state");
}

Deno.test("live requests preserve the selected channel, timezone and stop time", () => {
  const now = Date.parse("2026-10-30T18:00:00Z");
  const input = liveRequest({
    target,
    startAt: "2026-10-31T20:00:00+02:00",
    stopAt: "2026-10-31T22:00:00+02:00",
  }, now);
  equal(input.sourceUrl, target);
  equal(input.startAt, Date.parse("2026-10-31T18:00:00Z"));
  equal(input.stopAt, Date.parse("2026-10-31T20:00:00Z"));
  equal(
    liveSource(
      "https://new.diavlos.grnet.gr/el/epresence-conference/1234?foo=1",
    ),
    "https://new.diavlos.grnet.gr/el/epresence-conference/1234?foo=1",
  );
  equal(
    liveSource("https://cdn.example/live.m3u8?token=abc"),
    "https://cdn.example/live.m3u8?token=abc",
  );
  for (
    const invalid of [
      "file:///video.m3u8",
      "https://hellasnews.tv.evil.test/live/",
      "https://user:pass@hellasnews.tv/live/",
      "https://example.com/",
      "javascript:alert(1)",
    ]
  ) {
    throws(() => liveSource(invalid));
  }
  throws(() => liveRequest({ target, startAt: "2026-10-30T19:00" }, now));
  throws(() => liveRequest({ target, startAt: "2026-10-29T19:00:00Z" }, now));
  throws(() => liveRequest({ target, stopAt: "2026-10-30T17:00:00Z" }, now));
  throws(() => liveRequest({ target, format: "exe" }, now));
});

Deno.test("cancel during preparation never launches the recorder", async () => {
  const dir = await Deno.makeTempDir();
  let finishPrepare!: () => void;
  const prepared = new Promise<void>((resolve) => finishPrepare = resolve);
  let launches = 0;
  const manager = new LiveManager({
    stateDir: dir,
    prepare: () => prepared,
    launch: () => {
      launches++;
      return Promise.resolve(0);
    },
  });
  try {
    const job = await manager.create({ target }, dir);
    await manager.stop(job.id);
    finishPrepare();
    await until(() => job.status === "cancelled");
    equal(launches, 0);
    await manager.shutdown();
    const saved = JSON.parse(
      await Deno.readTextFile(join(dir, "live-jobs.json")),
    );
    equal(saved[0].status, "cancelled");
  } finally {
    finishPrepare();
    await manager.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("close saves pending schedules and restores them without stale stop markers", async () => {
  const dir = await Deno.makeTempDir();
  const configs: { stop_file: string }[] = [];
  const options = {
    stateDir: dir,
    prepare: () => Promise.resolve(),
    launch: async (configFile: string, log: (line: string) => void) => {
      const config = JSON.parse(await Deno.readTextFile(configFile));
      configs.push(config);
      log('SVID_LIVE {"status":"scheduled","message":"Waiting"}');
      while (true) {
        try {
          await Deno.stat(config.stop_file);
          return 130;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await pause();
      }
    },
  };
  const first = new LiveManager(options);
  let second: LiveManager | undefined;
  try {
    const job = await first.create({
      target,
      startAt: new Date(Date.now() + 3600000).toISOString(),
    }, dir);
    await until(() => configs.length === 1);
    await first.shutdown();
    equal(job.status, "scheduled");
    second = new LiveManager(options);
    await second.restore();
    await until(() => configs.length === 2);
    ok(configs[0].stop_file !== configs[1].stop_file);
    equal(second.jobs.get(job.id)?.status, "scheduled");
    await second.stop(job.id);
    await until(() => second!.jobs.get(job.id)?.status === "cancelled");
    await second.shutdown();
    const saved = JSON.parse(
      await Deno.readTextFile(join(dir, "live-jobs.json")),
    );
    equal(saved[0].status, "cancelled");
  } finally {
    await first.shutdown();
    await second?.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("closing a recording waits for its final output", async () => {
  const dir = await Deno.makeTempDir();
  const output = join(dir, "recording.mp4");
  const manager = new LiveManager({
    stateDir: dir,
    prepare: () => Promise.resolve(),
    launch: async (configFile, log) => {
      const config = JSON.parse(await Deno.readTextFile(configFile));
      log('SVID_LIVE {"status":"recording","message":"Recording"}');
      while (true) {
        try {
          await Deno.stat(config.stop_file);
          break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await pause();
      }
      log("SVID_LIVE " + JSON.stringify({ output, message: "Saved" }));
      return 0;
    },
  });
  try {
    const job = await manager.create({ target, title: "<meeting>" }, dir);
    await until(() => job.status === "recording");
    await manager.shutdown();
    equal(job.status, "done");
    equal(job.outputFile, output);
    const saved = JSON.parse(
      await Deno.readTextFile(join(dir, "live-jobs.json")),
    );
    equal(saved[0].outputFile, output);
    equal(saved[0].status, "done");
  } finally {
    await manager.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a corrupt schedule is reported and never overwritten", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "live-jobs.json");
  await Deno.writeTextFile(file, "broken");
  try {
    const manager = new LiveManager({
      stateDir: dir,
      prepare: () => Promise.resolve(),
      launch: () => Promise.resolve(0),
    });
    await rejects(() => manager.restore(), /Could not read/);
    deepEqual(await Deno.readTextFile(file), "broken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
