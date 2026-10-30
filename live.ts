import { join } from "node:path";

export type LiveStatus =
  | "scheduled"
  | "preparing"
  | "standby"
  | "recording"
  | "stopping"
  | "done"
  | "cancelled"
  | "failed";

export type LiveJob = {
  kind: "live";
  id: string;
  title: string;
  sourceUrl: string;
  startAt: number;
  stopAt?: number;
  format: "mp4" | "ts";
  outputDir: string;
  sessionDir: string;
  status: LiveStatus;
  logs: string[];
  latestLine: string;
  progress: number | null;
  createdAt: number;
  finishedAt?: number;
  outputFile?: string;
};

export function liveIsActive(job: LiveJob): boolean {
  return !["done", "cancelled", "failed"].includes(job.status);
}

export function liveSource(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Enter a valid Diavlos, Hellas News or HLS URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) || url.username || url.password
  ) {
    throw new Error(
      "Live sources must use an HTTP or HTTPS URL without credentials.",
    );
  }
  const host = url.hostname.toLowerCase();
  const diavlos = ["diavlos.grnet.gr", "new.diavlos.grnet.gr"].includes(host);
  const hellas = ["hellasnews.tv", "www.hellasnews.tv"].includes(host);
  if (
    !(diavlos && /\/epresence-conference\/\d+\/?$/.test(url.pathname)) &&
    !(hellas && /^\/live\/?$/.test(url.pathname)) &&
    !/\.m3u8$/i.test(url.pathname)
  ) {
    throw new Error(
      "Use a Diavlos ePresence event, a Hellas News /live/ page or a direct .m3u8 URL.",
    );
  }
  return url.href;
}

function timestamp(value: unknown, label: string): number {
  // The UI sends an ISO instant including its timezone, never an ambiguous local string.
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must include a valid date, time and timezone.`);
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new Error(`Invalid ${label.toLowerCase()}.`);
  }
  return result;
}

export function liveRequest(
  body: Record<string, unknown>,
  now = Date.now(),
): {
  sourceUrl: string;
  startAt: number;
  stopAt?: number;
  format: "mp4" | "ts";
  title: string;
} {
  const sourceUrl = liveSource(body.target);
  const startAt = body.startAt ? timestamp(body.startAt, "Start time") : now;
  // Allow a small transport delay for Start Now, but reject accidentally past schedules.
  if (startAt < now - 60_000) {
    throw new Error(
      "The start time has already passed. Choose a future time or Start Now.",
    );
  }
  const stopAt = body.stopAt ? timestamp(body.stopAt, "Stop time") : undefined;
  if (stopAt !== undefined && stopAt <= Math.max(startAt, now)) {
    throw new Error(
      "Stop time must be later than the start time and the current time.",
    );
  }
  if (
    body.format !== undefined && body.format !== "mp4" && body.format !== "ts"
  ) {
    throw new Error("Choose MP4 or TS for the live recording.");
  }
  const title = String(body.title ?? "").trim().slice(0, 120) ||
    (new URL(sourceUrl).hostname.includes("hellasnews")
      ? "Hellas News"
      : new URL(sourceUrl).hostname.includes("diavlos")
      ? "Diavlos"
      : "Live");
  return {
    sourceUrl,
    startAt,
    stopAt,
    format: body.format === "ts" ? "ts" : "mp4",
    title,
  };
}

type LiveOptions = {
  stateDir: string;
  prepare: (log: (line: string) => void) => Promise<void>;
  launch: (config: string, log: (line: string) => void) => Promise<number>;
};

export class LiveManager {
  readonly jobs = new Map<string, LiveJob>();
  private workers = new Map<string, Promise<void>>();
  private saveQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private preparation?: Promise<void>;
  private instanceId = crypto.randomUUID();
  private stopRequests = new Set<string>();

  constructor(private options: LiveOptions) {}

  private log(job: LiveJob, line: string) {
    job.latestLine = line;
    job.logs.push(line);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify([...this.jobs.values()], null, 2);
    const file = join(this.options.stateDir, "live-jobs.json");
    const write = this.saveQueue.catch(() => {}).then(async () => {
      await Deno.mkdir(this.options.stateDir, { recursive: true });
      await Deno.writeTextFile(`${file}.tmp`, snapshot);
      await Deno.rename(`${file}.tmp`, file);
    });
    this.saveQueue = write;
    return write;
  }

  async restore(): Promise<void> {
    let saved: LiveJob[];
    try {
      const raw: unknown = JSON.parse(
        await Deno.readTextFile(join(this.options.stateDir, "live-jobs.json")),
      );
      if (!Array.isArray(raw)) {
        throw new Error("Live schedule file is invalid.");
      }
      saved = raw;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      // Never silently replace a corrupt schedule file.
      throw new Error(`Could not read saved live recordings: ${error}`);
    }
    for (const job of saved) {
      if (!job || !/^[\da-f-]{36}$/i.test(job.id) || job.kind !== "live") {
        continue;
      }
      if (
        !Array.isArray(job.logs) || !Number.isFinite(job.startAt) ||
        typeof job.sessionDir !== "string"
      ) continue;
      this.jobs.set(job.id, job);
      if (liveIsActive(job)) {
        if (
          job.status === "scheduled" || job.status === "preparing" ||
          job.status === "standby"
        ) {
          if (job.stopAt !== undefined && job.stopAt <= Date.now()) {
            job.status = "cancelled";
            job.finishedAt = Date.now();
            this.log(job, "Scheduled recording expired while Svid was closed.");
          } else {
            job.status = "scheduled";
            this.log(
              job,
              "Saved schedule restored. Waiting for the start time / live stream.",
            );
          }
        } else {
          job.status = "failed";
          job.finishedAt = Date.now();
          this.log(
            job,
            `Recording was interrupted. Saved parts are kept in ${job.sessionDir}`,
          );
        }
      }
    }
    await this.save();
    for (const job of this.jobs.values()) {
      if (liveIsActive(job)) this.begin(job);
    }
  }

  async create(
    body: Record<string, unknown>,
    outputDir: string,
  ): Promise<LiveJob> {
    if (this.closing) {
      throw new Error("Svid is closing. Reopen it to schedule a recording.");
    }
    const input = liveRequest(body);
    const id = crypto.randomUUID();
    const stamp = new Date(input.startAt).toISOString().replace(/[:.]/g, "-");
    const name = input.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(
      /[. ]+$/,
      "",
    );
    const job: LiveJob = {
      ...input,
      kind: "live",
      id,
      title: `Live: ${input.title}`,
      outputDir,
      sessionDir: join(outputDir, `${name}-${stamp}-${id.slice(0, 8)}`),
      status: "scheduled",
      logs: [],
      latestLine: "",
      progress: null,
      createdAt: Date.now(),
    };
    this.log(
      job,
      `Start: ${
        new Date(job.startAt).toLocaleString()
      }. Waiting automatically if the live stream is offline.`,
    );
    this.jobs.set(id, job);
    try {
      await this.save();
    } catch (error) {
      this.jobs.delete(id);
      throw error;
    }
    this.begin(job);
    return job;
  }

  private begin(job: LiveJob) {
    const worker = this.run(job).finally(() => this.workers.delete(job.id));
    this.workers.set(job.id, worker);
  }

  private controlDir(job: LiveJob): string {
    return join(this.options.stateDir, "live-control", job.id);
  }

  private stopFile(job: LiveJob): string {
    return join(this.controlDir(job), `stop-${this.instanceId}`);
  }

  async stop(id: string): Promise<LiveJob | undefined> {
    const job = this.jobs.get(id);
    if (!job || !liveIsActive(job)) return job;
    this.stopRequests.add(id);
    job.status = "stopping";
    const dir = this.controlDir(job);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(this.stopFile(job), "stop");
    this.log(job, "Stopping and saving the recorded parts...");
    await this.save();
    return job;
  }

  private async run(job: LiveJob): Promise<void> {
    try {
      job.status = "preparing";
      this.log(
        job,
        "Preparing live capture tools (first use may take a few minutes)...",
      );
      await this.save();
      const dir = this.controlDir(job);
      await Deno.mkdir(dir, { recursive: true });
      this.preparation ??= this.options.prepare((line) => this.log(job, line))
        .catch((error) => {
          this.preparation = undefined;
          throw error;
        });
      await this.preparation;
      if (this.stopRequests.has(job.id) || this.closing) {
        job.status = "cancelled";
        this.log(job, "Cancelled before capture started.");
        return;
      }
      const config = join(dir, "config.json");
      await Deno.writeTextFile(
        config,
        JSON.stringify({
          url: job.sourceUrl,
          start_at: job.startAt / 1000,
          stop_at: job.stopAt === undefined ? null : job.stopAt / 1000,
          format: job.format,
          output_dir: job.sessionDir,
          stop_file: this.stopFile(job),
        }),
      );
      const code = await this.options.launch(config, (line) => {
        if (line.startsWith("SVID_LIVE ")) {
          try {
            const event = JSON.parse(line.slice(10));
            if (
              ["scheduled", "preparing", "standby", "recording", "stopping"]
                .includes(event.status) && !this.stopRequests.has(job.id)
            ) {
              job.status = event.status;
            }
            if (event.output) job.outputFile = String(event.output);
            if (event.message) this.log(job, String(event.message));
            this.save().catch((error) =>
              this.log(job, `Could not save live state: ${error}`)
            );
          } catch {
            this.log(job, line);
          }
        } else {
          this.log(job, line);
        }
      });
      job.status = code === 0 ? "done" : code === 130 ? "cancelled" : "failed";
      if (code === 0) job.progress = 100;
      this.log(
        job,
        code === 0
          ? "Live recording saved."
          : code === 130
          ? "Cancelled; no media was recorded."
          : "Live capture failed. Check the logs; any saved parts are kept.",
      );
    } catch (error) {
      job.status = "failed";
      this.log(job, error instanceof Error ? error.message : String(error));
    } finally {
      job.finishedAt = Date.now();
      await this.save().catch((error) =>
        console.error("Could not save live state:", error)
      );
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const pending = [...this.jobs.values()].filter((job) =>
      ["scheduled", "preparing", "standby"].includes(job.status)
    );
    await Promise.all(
      [...this.jobs.values()].filter(liveIsActive).map((job) =>
        this.stop(job.id)
      ),
    );
    await Promise.all(this.workers.values());
    // Waiting jobs resume next launch. Recordings stopped on close remain finished.
    for (const job of pending) {
      if (job.outputFile) continue;
      job.status = "scheduled";
      delete job.finishedAt;
      this.log(
        job,
        "Schedule saved. Keep Svid open and the computer awake at the start time.",
      );
    }
    await this.save();
  }
}
