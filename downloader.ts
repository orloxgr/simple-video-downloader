import { basename, dirname, join, parse, resolve } from "node:path";

const APP_VERSION = "2.3.1";
const APP_NAME = "Svid";
const APP_TAGLINE = "Simple Video Download Cut and Convert";
const APP_REPO = "orloxgr/simple-video-downloader";
const APP_LATEST_RELEASE_API =
  `https://api.github.com/repos/${APP_REPO}/releases/latest`;
const UV_DOWNLOAD_URL =
  "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip";

const appDir = dirname(Deno.execPath());
const isWindows = Deno.build.os === "windows";
const userHome = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? appDir;
const userDownloadsDir = join(userHome, "Downloads");
const userVideosDir = join(userHome, "Videos");
const svidVideosDir = join(userVideosDir, "Svid");
const exe = (name: string) => join(appDir, isWindows ? `${name}.exe` : name);
const settingsFile = join(appDir, "settings.json");

type ToolName = "yt-dlp" | "ffmpeg" | "deno";
type UpdateTarget = ToolName | "svid";
type UpdateInterval = "3d" | "7d" | "30d" | "90d" | "365d" | "never";
type LocalAction = "audio" | "mp4" | "mkv" | "cut";
type WebAction = "mp4" | "mkv" | "mp3" | "native";
type ConvertQuality = "copy" | "high" | "balanced" | "small";
type SubtitleOutputMode = "srt" | "ass-highlight";
type LogFn = (line: string) => void;
type Runner = (command: string, args: string[]) => Promise<number>;
type CommandOutput = { code: number; stdout: string; stderr: string };

type ProcessOptions = {
  runner?: Runner;
  log?: LogFn;
  outputDir?: string;
  start?: string;
  end?: string;
  quality?: string;
};

type AppSettings = {
  updateIntervals: Record<UpdateTarget, UpdateInterval>;
  lastUpdateChecks: Partial<Record<UpdateTarget, number>>;
  outputDirs: {
    downloads: string;
    cuts: string;
    converts: string;
    subtitles: string;
  };
};

const intervalDays: Record<Exclude<UpdateInterval, "never">, number> = {
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

const defaultSettings: AppSettings = {
  updateIntervals: {
    svid: "7d",
    "yt-dlp": "7d",
    ffmpeg: "7d",
    deno: "7d",
  },
  lastUpdateChecks: {},
  outputDirs: {
    downloads: userDownloadsDir,
    cuts: join(svidVideosDir, "cuts"),
    converts: join(svidVideosDir, "converts"),
    subtitles: join(svidVideosDir, "subtitles"),
  },
};

const legacyDefaultOutputDirs: AppSettings["outputDirs"] = {
  downloads: join(appDir, "downloads"),
  cuts: join(appDir, "cuts"),
  converts: join(appDir, "converts"),
  subtitles: join(appDir, "subtitles"),
};

function toolEnv(): Record<string, string> {
  const pathKey =
    Object.keys(Deno.env.toObject()).find((key) =>
      key.toLowerCase() === "path"
    ) ?? "PATH";
  const currentPath = Deno.env.get(pathKey) ?? "";
  return {
    [pathKey]: `${appDir}${isWindows ? ";" : ":"}${currentPath}`,
  };
}

function header() {
  console.clear();
  console.log(`${APP_NAME} v${APP_VERSION}`);
  console.log("Made by Byron Iniotakis");
  console.log();
}

function isUpdateInterval(value: unknown): value is UpdateInterval {
  return value === "3d" || value === "7d" || value === "30d" ||
    value === "90d" || value === "365d" || value === "never";
}

function normalizeSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === "object"
    ? raw as Partial<AppSettings>
    : {};
  const updateIntervals = { ...defaultSettings.updateIntervals };
  const lastUpdateChecks: Partial<Record<UpdateTarget, number>> = {};
  const outputDirs = { ...defaultSettings.outputDirs };

  for (const tool of ["svid", "yt-dlp", "ffmpeg", "deno"] as const) {
    const interval = source.updateIntervals?.[tool];
    if (isUpdateInterval(interval)) updateIntervals[tool] = interval;

    const last = source.lastUpdateChecks?.[tool];
    if (typeof last === "number" && Number.isFinite(last)) {
      lastUpdateChecks[tool] = last;
    }
  }

  for (
    const key of ["downloads", "cuts", "converts", "subtitles"] as const
  ) {
    const value = source.outputDirs?.[key];
    if (typeof value === "string" && value.trim()) {
      const normalized = resolve(value.trim());
      outputDirs[key] = normalized === resolve(legacyDefaultOutputDirs[key])
        ? defaultSettings.outputDirs[key]
        : normalized;
    }
  }

  return { updateIntervals, lastUpdateChecks, outputDirs };
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await Deno.readTextFile(settingsFile);
    return normalizeSettings(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch {
    return structuredClone(defaultSettings);
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await Deno.writeTextFile(
    settingsFile,
    `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function windowsCommandLineArg(value: string): string {
  if (value !== "" && !/[ \t\n\v"]/.test(value)) return value;

  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      continue;
    }

    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }

    result += "\\".repeat(backslashes);
    result += char;
    backslashes = 0;
  }

  result += "\\".repeat(backslashes * 2);
  result += '"';
  return result;
}

function base64Utf16Le(value: string): string {
  const bytes = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

async function runWindowsHidden(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; log?: LogFn } = {},
): Promise<CommandOutput> {
  const tempDir = await Deno.makeTempDir({ prefix: "svdc-run-" });
  const outFile = join(tempDir, "stdout.log");
  const errFile = join(tempDir, "stderr.log");
  const scriptFile = join(tempDir, "run.vbs");
  const cwd = options.cwd ?? appDir;
  const env = { ...toolEnv(), ...(options.env ?? {}) };
  const pathEntry = Object.entries(env).find(([key]) =>
    key.toLowerCase() === "path"
  );
  await Deno.writeTextFile(outFile, "");
  await Deno.writeTextFile(errFile, "");

  const psArgs = args.map(windowsCommandLineArg).join(" ");
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `$env:PATH = ${
      powershellString(pathEntry?.[1] ?? Deno.env.get("PATH") ?? "")
    }`,
    ...(Object.entries(options.env ?? {}).map(([key, value]) =>
      `$env:${key} = ${powershellString(value)}`
    )),
    `$argumentLine = ${powershellString(psArgs)}`,
    `$p = Start-Process -FilePath ${
      powershellString(command)
    } -ArgumentList $argumentLine -WorkingDirectory ${
      powershellString(cwd)
    } -WindowStyle Hidden -RedirectStandardOutput ${
      powershellString(outFile)
    } -RedirectStandardError ${powershellString(errFile)} -Wait -PassThru`,
    "$p.Refresh()",
    "if ($null -ne $p.ExitCode -and $p.ExitCode -eq 0) { exit 0 }",
    "exit 1",
  ].join("\r\n");
  const encoded = base64Utf16Le(psScript);
  const redirected =
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    `code = shell.Run(${vbsString(redirected)}, 0, True)`,
    "WScript.Quit code",
    "",
  ].join("\r\n");

  await Deno.writeTextFile(scriptFile, script);

  const child = new Deno.Command("wscript.exe", {
    args: ["//nologo", scriptFile],
    cwd,
    env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  let done = false;
  const pump = async (path: string) => {
    let cursor = 0;
    let pending = "";

    while (!done) {
      const text = await readTextIfExists(path);
      if (text.length > cursor) {
        const chunk = text.slice(cursor);
        cursor = text.length;
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/g);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) options.log?.(line);
        }
      }
      await delay(180);
    }

    const text = await readTextIfExists(path);
    if (text.length > cursor) pending += text.slice(cursor);
    for (const line of pending.split(/\r?\n|\r/g)) {
      if (line.trim()) options.log?.(line);
    }
  };

  const pumpers = options.log
    ? Promise.all([pump(outFile), pump(errFile)])
    : Promise.resolve();

  const status = await child.status;
  done = true;
  await pumpers;

  const stdout = await readTextIfExists(outFile);
  const stderr = await readTextIfExists(errFile);
  await removePath(tempDir);

  return { code: status.code, stdout, stderr };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<number> {
  if (isWindows) {
    const output = await runWindowsHidden(command, args, options);
    if (output.stdout.trim()) console.log(output.stdout.trim());
    if (output.stderr.trim()) console.error(output.stderr.trim());
    return output.code;
  }

  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd ?? appDir,
    env: { ...toolEnv(), ...(options.env ?? {}) },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();

  const decoder = new TextDecoder();
  const stdout = decoder.decode(output.stdout).trim();
  const stderr = decoder.decode(output.stderr).trim();

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);

  return output.code;
}

async function runLogged(
  command: string,
  args: string[],
  log: LogFn,
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<number> {
  log(`> ${basename(command)} ${args.join(" ")}`);

  if (isWindows) {
    const output = await runWindowsHidden(command, args, { ...options, log });
    return output.code;
  }

  const child = new Deno.Command(command, {
    args,
    cwd: options.cwd ?? appDir,
    env: { ...toolEnv(), ...(options.env ?? {}) },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";

    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log(line);
      }
    }

    pending += decoder.decode();
    if (pending.trim()) log(pending);
  };

  const [status] = await Promise.all([
    child.status,
    pump(child.stdout),
    pump(child.stderr),
  ]);

  return status.code;
}

async function capture(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (isWindows) {
    return await runWindowsHidden(command, args);
  }

  const output = await new Deno.Command(command, {
    args,
    cwd: appDir,
    env: toolEnv(),
    stdout: "piped",
    stderr: "piped",
  }).output();

  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function browseWindowsFile(
  title = "Select file",
  filter = "All files (*.*)|*.*",
): Promise<string | null> {
  if (!isWindows) return null;

  const tempDir = await Deno.makeTempDir({ prefix: "svdc-picker-" });
  const resultFile = join(tempDir, "selected.txt");

  try {
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      `$dialog.Title = ${powershellString(title)}`,
      `$dialog.Filter = ${powershellString(filter)}`,
      "$dialog.Multiselect = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      `  [System.IO.File]::WriteAllText(${
        powershellString(resultFile)
      }, $dialog.FileName, [System.Text.UTF8Encoding]::new($false))`,
      "}",
    ].join("\r\n");
    const encoded = base64Utf16Le(psScript);
    const redirected =
      `powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    const scriptFile = join(tempDir, "picker.vbs");
    const script = [
      'Set shell = CreateObject("WScript.Shell")',
      `code = shell.Run(${vbsString(redirected)}, 0, True)`,
      "WScript.Quit code",
      "",
    ].join("\r\n");

    await Deno.writeTextFile(scriptFile, script);
    await new Deno.Command("wscript.exe", {
      args: ["//nologo", scriptFile],
      cwd: appDir,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().status;

    const selected = (await readTextIfExists(resultFile)).trim();
    return selected || null;
  } finally {
    await removePath(tempDir);
  }
}

async function browseWindowsVideoFile(): Promise<string | null> {
  return await browseWindowsFile(
    "Select video or audio file",
    "Media files (*.mp4;*.mkv;*.mov;*.webm;*.avi;*.m4v;*.mp3;*.wav;*.m4a;*.flac;*.aac)|*.mp4;*.mkv;*.mov;*.webm;*.avi;*.m4v;*.mp3;*.wav;*.m4a;*.flac;*.aac|All files (*.*)|*.*",
  );
}

async function browseWindowsTextFile(): Promise<string | null> {
  return await browseWindowsFile(
    "Select text file",
    "Text files (*.txt)|*.txt|All files (*.*)|*.*",
  );
}

async function downloadFile(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  }

  const file = await Deno.open(destination, {
    create: true,
    write: true,
    truncate: true,
  });
  try {
    await response.body.pipeTo(file.writable);
  } finally {
    try {
      file.close();
    } catch {
      // The stream normally closes the file already.
    }
  }
}

type SvidRelease = {
  version: string;
  tagName: string;
  setupUrl: string;
  releaseUrl: string;
};

function parseVersion(value: string): number[] {
  const clean = value.trim().replace(/^v/i, "");
  return clean.split(".").map((part) => {
    const value = Number(part.replace(/[^\d].*$/, ""));
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function latestSvidRelease(): Promise<SvidRelease> {
  const response = await fetch(APP_LATEST_RELEASE_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `${APP_NAME}/${APP_VERSION}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub release check failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const setup = assets.find((asset: unknown) => {
    if (!asset || typeof asset !== "object") return false;
    const name = "name" in asset ? String(asset.name) : "";
    return name.toLowerCase() === "svid-setup.exe";
  }) as { browser_download_url?: string } | undefined;

  if (!setup?.browser_download_url) {
    throw new Error("Latest GitHub release does not include Svid-Setup.exe.");
  }

  const tagName = String(payload.tag_name ?? "");
  return {
    version: tagName.replace(/^v/i, ""),
    tagName,
    setupUrl: setup.browser_download_url,
    releaseUrl: String(payload.html_url ?? ""),
  };
}

async function checkSvidUpdate(
  scheduled = false,
): Promise<Record<string, unknown>> {
  const todayDays = Math.floor(Date.now() / 86_400_000);
  const settings = await loadSettings();
  const interval = settings.updateIntervals.svid;

  if (scheduled && interval === "never") {
    return {
      checked: false,
      reason: "disabled",
      currentVersion: APP_VERSION,
    };
  }

  if (scheduled && interval !== "never") {
    const days = intervalDays[interval];
    const lastDays = settings.lastUpdateChecks.svid;
    const diff = typeof lastDays === "number"
      ? todayDays - lastDays
      : Number.POSITIVE_INFINITY;

    if (diff < days && diff >= 0) {
      return {
        checked: false,
        reason: "not-due",
        currentVersion: APP_VERSION,
        daysSinceLastCheck: diff,
      };
    }
  }

  const release = await latestSvidRelease();
  settings.lastUpdateChecks.svid = todayDays;
  await saveSettings(settings);

  return {
    checked: true,
    currentVersion: APP_VERSION,
    latestVersion: release.version,
    tagName: release.tagName,
    releaseUrl: release.releaseUrl,
    updateAvailable: compareVersions(release.version, APP_VERSION) > 0,
  };
}

async function installLatestSvidUpdate(): Promise<Record<string, unknown>> {
  const release = await latestSvidRelease();
  if (compareVersions(release.version, APP_VERSION) <= 0) {
    return {
      started: false,
      updateAvailable: false,
      currentVersion: APP_VERSION,
      latestVersion: release.version,
    };
  }

  const tempDir = await Deno.makeTempDir({ prefix: "svid-update-" });
  const setupPath = join(tempDir, "Svid-Setup.exe");
  await downloadFile(release.setupUrl, setupPath);

  new Deno.Command(setupPath, {
    cwd: tempDir,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  return {
    started: true,
    updateAvailable: true,
    currentVersion: APP_VERSION,
    latestVersion: release.version,
    setupPath,
  };
}

async function removePath(path: string) {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });

  if (isWindows) {
    const code = await run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:ZIP_PATH -DestinationPath $env:DEST_PATH -Force",
      ],
      {
        env: {
          ZIP_PATH: zipPath,
          DEST_PATH: destination,
        },
      },
    );

    if (code !== 0) {
      throw new Error("Could not extract zip with PowerShell Expand-Archive.");
    }
    return;
  }

  const code = await run("unzip", ["-o", zipPath, "-d", destination]);
  if (code !== 0) throw new Error("Could not extract zip with unzip.");
}

async function ensureTool(
  name: ToolName,
): Promise<boolean> {
  const file = exe(name);
  if (await exists(file)) return true;

  console.log(
    `[!] ${basename(file)} is missing. Downloading to current folder...`,
  );

  try {
    if (name === "yt-dlp") {
      await downloadFile(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
        file,
      );
    }

    if (name === "deno") {
      const zip = join(appDir, "deno.zip");
      await downloadFile(
        "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
        zip,
      );
      await extractZip(zip, appDir);
      await removePath(zip);
    }

    if (name === "ffmpeg") {
      await updateFfmpeg();
    }
  } catch (error) {
    console.log(`ERROR: Failed to download ${basename(file)}.`);
    console.log(error instanceof Error ? error.message : String(error));
    return false;
  }

  if (await exists(file)) {
    console.log(`[OK] ${basename(file)} downloaded successfully.`);
    console.log();
    return true;
  }

  console.log(`ERROR: Failed to download ${basename(file)}.`);
  return false;
}

async function maybeUpdateTools(log: LogFn = console.log) {
  const todayDays = Math.floor(Date.now() / 86_400_000);
  const settings = await loadSettings();

  log("===== Checking tool update schedule =====");

  for (const tool of ["yt-dlp", "ffmpeg", "deno"] as const) {
    const interval = settings.updateIntervals[tool];
    if (interval === "never") {
      log(`${tool}: automatic update checks disabled.`);
      continue;
    }

    const days = intervalDays[interval];
    const lastDays = settings.lastUpdateChecks[tool];
    const diff = typeof lastDays === "number"
      ? todayDays - lastDays
      : Number.POSITIVE_INFINITY;

    if (diff < days && diff >= 0) {
      log(`${tool}: skipped; last checked ${diff} day(s) ago.`);
      continue;
    }

    await updateTool(tool, log);
    settings.lastUpdateChecks[tool] = todayDays;
    await saveSettings(settings);
  }

  log("Update schedule complete.");
}

async function updateTool(tool: ToolName, log: LogFn = console.log) {
  if (tool === "yt-dlp" && await exists(exe("yt-dlp"))) {
    log("[*] Updating yt-dlp...");
    const code = await run(exe("yt-dlp"), ["-U"]);
    if (code !== 0) {
      log("    (update skipped - offline or already current)");
    }
    return;
  }

  if (tool === "deno" && await exists(exe("deno"))) {
    log("[*] Updating deno...");
    const code = await run(exe("deno"), ["upgrade"]);
    if (code !== 0) {
      log("    (update skipped - offline or already current)");
    }
    return;
  }

  if (tool === "ffmpeg") {
    log("[*] Checking ffmpeg...");
    await updateFfmpeg(log);
  }
}

async function latestFfmpegVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      "https://www.gyan.dev/ffmpeg/builds/release-version",
    );
    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  }
}

async function currentFfmpegVersion(): Promise<string> {
  if (!(await exists(exe("ffmpeg")))) return "";

  const result = await capture(exe("ffmpeg"), ["-version"]);
  const match = result.stdout.match(/^ffmpeg version\s+([^\s-]+)/m);
  return match?.[1] ?? "";
}

async function updateFfmpeg(log: LogFn = console.log) {
  const latest = await latestFfmpegVersion();
  if (!latest) {
    log(
      "    ffmpeg: version check failed (offline?) - keeping current build",
    );
    return;
  }

  const current = await currentFfmpegVersion();
  if (current === latest) {
    log(`    ffmpeg already latest (${latest})`);
    return;
  }

  log(
    `    ffmpeg update: have [${
      current || "missing"
    }] latest [${latest}] - downloading...`,
  );
  await downloadFfmpeg(log);
}

async function downloadFfmpeg(log: LogFn = console.log) {
  const zip = join(appDir, "ffmpeg.zip");
  const temp = join(appDir, "ffmpeg_temp");

  try {
    await removePath(temp);
    await downloadFile(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      zip,
    );
    await extractZip(zip, temp);

    for await (const file of walk(temp)) {
      const fileName = basename(file).toLowerCase();
      if (fileName === "ffmpeg.exe" || fileName === "ffprobe.exe") {
        await Deno.copyFile(file, join(appDir, fileName));
      }
    }
  } catch (error) {
    log("    (ffmpeg download skipped - offline?)");
    if (error instanceof Error) log(`    ${error.message}`);
  } finally {
    await removePath(temp);
    await removePath(zip);
  }
}

async function ensureUv(log: LogFn = console.log): Promise<boolean> {
  const uv = exe("uv");
  if (await exists(uv)) return true;

  log("uv is missing. Downloading subtitle tool runner...");
  const zip = join(appDir, "uv.zip");
  const temp = join(appDir, "uv_temp");

  try {
    await removePath(temp);
    await downloadFile(UV_DOWNLOAD_URL, zip);
    await extractZip(zip, temp);

    let found = false;
    for await (const file of walk(temp)) {
      if (basename(file).toLowerCase() === "uv.exe") {
        await Deno.copyFile(file, uv);
        found = true;
        break;
      }
    }

    if (!found) {
      log("uv.exe was not found in the downloaded archive.");
      return false;
    }

    log("uv downloaded successfully.");
    return true;
  } catch (error) {
    log("uv download failed.");
    if (error instanceof Error) log(error.message);
    return false;
  } finally {
    await removePath(temp);
    await removePath(zip);
  }
}

async function* walk(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

function cleanInput(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function selectChoice(max: number): number | null {
  const raw = prompt(`Select action (1-${max}): `)?.trim() || "1";
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function parseTime(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;

  const plainSeconds = Number(normalized);
  if (Number.isFinite(plainSeconds) && plainSeconds >= 0) return plainSeconds;

  const parts = normalized.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;

  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60) return null;
  if (!Number.isInteger(minutes) || minutes < 0) return null;
  if (parts.length === 3 && minutes >= 60) return null;
  if (!Number.isInteger(hours) || hours < 0) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

function timeTag(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(
    ".",
    "_",
  );
}

function convertQuality(value: unknown): ConvertQuality {
  return value === "high" || value === "balanced" || value === "small"
    ? value
    : "copy";
}

function videoQualitySettings(quality: ConvertQuality): {
  suffix: string;
  crf: string;
  audioBitrate: string;
} {
  if (quality === "high") {
    return { suffix: "high", crf: "18", audioBitrate: "192k" };
  }
  if (quality === "small") {
    return { suffix: "small", crf: "28", audioBitrate: "128k" };
  }
  return { suffix: "balanced", crf: "23", audioBitrate: "160k" };
}

function audioQualityArgs(quality: ConvertQuality): string[] {
  if (quality === "high") return ["-b:a", "320k"];
  if (quality === "balanced") return ["-b:a", "192k"];
  if (quality === "small") return ["-b:a", "128k"];
  return ["-q:a", "0"];
}

async function moveReplace(source: string, destination: string): Promise<void> {
  await removePath(destination);
  try {
    await Deno.rename(source, destination);
  } catch {
    await Deno.copyFile(source, destination);
    await removePath(source);
  }
}

async function createInputAlias(target: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const parsed = parse(resolve(target));
  const extension = parsed.ext || ".media";
  const candidates = [
    parsed.dir,
    Deno.env.get("TEMP") ?? appDir,
  ];

  for (const dir of candidates) {
    try {
      await Deno.mkdir(dir, { recursive: true });
      const alias = join(dir, `.svdc-input-${crypto.randomUUID()}${extension}`);
      try {
        await Deno.link(target, alias);
      } catch {
        await Deno.copyFile(target, alias);
      }
      return {
        path: alias,
        cleanup: () => removePath(alias),
      };
    } catch {
      // Try the next location before falling back to the original path.
    }
  }

  return {
    path: target,
    cleanup: () => Promise.resolve(),
  };
}

async function runFfmpegWithSafePaths(
  target: string,
  output: string,
  buildArgs: (input: string, output: string) => string[],
  options: ProcessOptions = {},
): Promise<number> {
  const outputParsed = parse(resolve(output));
  await Deno.mkdir(outputParsed.dir, { recursive: true });
  const outputAlias = join(
    outputParsed.dir,
    `.svdc-output-${crypto.randomUUID()}${outputParsed.ext || ".media"}`,
  );
  const inputAlias = await createInputAlias(target);
  const runner = options.runner ?? run;

  try {
    const code = await runner(
      exe("ffmpeg"),
      buildArgs(inputAlias.path, outputAlias),
    );
    if (code !== 0) return code;
    if (!(await exists(outputAlias))) return 1;
    await moveReplace(outputAlias, output);
    return 0;
  } finally {
    await inputAlias.cleanup();
    await removePath(outputAlias);
  }
}

async function cutLocalVideoRange(
  target: string,
  outputBase: string,
  start: number,
  end: number,
  options: ProcessOptions = {},
): Promise<number> {
  const duration = end - start;
  const output = `${outputBase}_cut_${timeTag(start)}-${timeTag(end)}.mp4`;
  const runner = options.runner ?? run;
  const log = options.log ?? console.log;

  log(`Start    : ${start} sec`);
  log(`End      : ${end} sec`);
  log(`Duration : ${duration} sec`);

  return await runFfmpegWithSafePaths(
    target,
    output,
    (input, ffmpegOutput) => [
      "-hide_banner",
      "-y",
      "-ss",
      String(start),
      "-i",
      input,
      "-t",
      String(duration),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      ffmpegOutput,
    ],
    { ...options, runner },
  );
}

async function cutLocalVideo(
  target: string,
  outputBase: string,
): Promise<number> {
  console.log();
  console.log("===== Accurate Video Cut =====");
  console.log("Enter start and end positions as seconds or timecode.");
  console.log("Accepted formats:");
  console.log("  Seconds : 72.500");
  console.log("  Timecode: 00:01:12.500  (example: 1 minute, 12.5 seconds)");
  console.log("            01:12.500     (same time, shorter format)");
  console.log();

  const startRaw = prompt("Start: ") ?? "";
  const endRaw = prompt("End: ") ?? "";
  const start = parseTime(startRaw);
  const end = parseTime(endRaw);

  if (start === null || end === null || end <= start) {
    console.log("ERROR: Invalid time range.");
    console.log("       Use seconds, MM:SS, or HH:MM:SS.");
    console.log("       Decimals are supported with dot or comma.");
    console.log("       End must be greater than Start.");
    return 1;
  }

  console.log();
  return await cutLocalVideoRange(target, outputBase, start, end);
}

async function processLocalFile(
  target: string,
  choice: LocalAction,
  options: ProcessOptions = {},
): Promise<number> {
  if (!(await exists(target))) {
    options.log?.(`Input file not found: ${target}`);
    return 1;
  }

  const parsed = parse(resolve(target));
  const outputDir = options.outputDir ?? parsed.dir;
  await Deno.mkdir(outputDir, { recursive: true });
  const outputBase = join(outputDir, parsed.name);
  const quality = convertQuality(options.quality);

  if (choice === "audio") {
    options.log?.(`Quality  : ${quality === "copy" ? "best MP3" : quality}`);
    return await runFfmpegWithSafePaths(
      target,
      `${outputBase}.mp3`,
      (input, output) => [
        "-hide_banner",
        "-y",
        "-i",
        input,
        "-map",
        "a",
        ...audioQualityArgs(quality),
        output,
      ],
      options,
    );
  }

  if (choice === "mp4") {
    if (quality !== "copy") {
      const settings = videoQualitySettings(quality);
      options.log?.(`Quality  : ${quality} (CRF ${settings.crf})`);
      return await runFfmpegWithSafePaths(
        target,
        `${outputBase}_${settings.suffix}.mp4`,
        (input, output) => [
          "-hide_banner",
          "-y",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          settings.crf,
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          settings.audioBitrate,
          "-movflags",
          "+faststart",
          output,
        ],
        options,
      );
    }

    options.log?.("Quality  : same quality / fast remux");
    return await runFfmpegWithSafePaths(
      target,
      `${outputBase}_remux.mp4`,
      (input, output) => [
        "-hide_banner",
        "-y",
        "-i",
        input,
        "-map",
        "0",
        "-c",
        "copy",
        output,
      ],
      options,
    );
  }

  if (choice === "mkv") {
    if (quality !== "copy") {
      const settings = videoQualitySettings(quality);
      options.log?.(`Quality  : ${quality} (CRF ${settings.crf})`);
      return await runFfmpegWithSafePaths(
        target,
        `${outputBase}_${settings.suffix}.mkv`,
        (input, output) => [
          "-hide_banner",
          "-y",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          settings.crf,
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          settings.audioBitrate,
          output,
        ],
        options,
      );
    }

    options.log?.("Quality  : same quality / fast remux");
    return await runFfmpegWithSafePaths(
      target,
      `${outputBase}_remux.mkv`,
      (input, output) => [
        "-hide_banner",
        "-y",
        "-i",
        input,
        "-map",
        "0",
        "-c",
        "copy",
        output,
      ],
      options,
    );
  }

  if (options.start !== undefined && options.end !== undefined) {
    const start = parseTime(options.start);
    const end = parseTime(options.end);
    if (start === null || end === null || end <= start) {
      options.log?.("Invalid cut range. End must be greater than start.");
      return 1;
    }
    return await cutLocalVideoRange(target, outputBase, start, end, options);
  }

  return await cutLocalVideo(target, outputBase);
}

function cleanLanguageCode(value: unknown): string {
  const raw = String(value ?? "el").trim().toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(raw) ? raw : "el";
}

function cleanSubtitleModel(value: unknown): string {
  const raw = String(value ?? "small").trim();
  return ["tiny", "base", "small", "medium", "large-v3"].includes(raw)
    ? raw
    : "small";
}

function cleanSubtitleWordsPerCue(value: unknown): number | null {
  const raw = String(value ?? "keep").trim().toLowerCase();
  if (raw === "keep") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20
    ? parsed
    : null;
}

function cleanSubtitleOutputMode(value: unknown): SubtitleOutputMode {
  return String(value ?? "srt").trim().toLowerCase() === "ass-highlight"
    ? "ass-highlight"
    : "srt";
}

function cleanAssFontSize(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "32"), 10);
  return Number.isInteger(parsed) && parsed >= 16 && parsed <= 96 ? parsed : 32;
}

function cleanHexColor(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : fallback;
}

function fileTimestamp(date = new Date()): string {
  const part = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${
    part(date.getDate())
  }-${part(date.getHours())}${part(date.getMinutes())}${
    part(date.getSeconds())
  }`;
}

async function prepareSubtitleScript(
  scriptPath: string,
  wordsPerCue: number | null,
  log: LogFn,
): Promise<{ path: string; cleanup?: () => Promise<void> }> {
  if (wordsPerCue === null) {
    log("Subtitle length: keep text lines");
    return { path: scriptPath };
  }

  const text = await Deno.readTextFile(scriptPath);
  const words = text.split(/\s+/).map((word) => word.trim()).filter(Boolean);
  if (!words.length) {
    throw new Error("Text file is empty.");
  }

  const lines: string[] = [];
  for (let index = 0; index < words.length; index += wordsPerCue) {
    lines.push(words.slice(index, index + wordsPerCue).join(" "));
  }

  const tempDir = await Deno.makeTempDir({ prefix: "svid-subtitles-" });
  const preparedPath = join(tempDir, "script.txt");
  await Deno.writeTextFile(preparedPath, `${lines.join("\n")}\n`);

  log(`Subtitle length: ${wordsPerCue} words per subtitle`);
  log(`Prepared text lines: ${lines.length}`);

  return {
    path: preparedPath,
    cleanup: () => removePath(tempDir),
  };
}

type SrtCue = {
  start: number;
  end: number;
  text: string;
};

type AssStyleOptions = {
  fontSize: number;
  activeColor: string;
  passedColor: string;
};

const defaultAssStyle: AssStyleOptions = {
  fontSize: 32,
  activeColor: "#D33360",
  passedColor: "#F0F0F0",
};

function parseSrtTime(value: string): number | null {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) +
    Number(milliseconds) / 1000;
}

function formatAssTime(value: number): string {
  const totalCentiseconds = Math.max(0, Math.round(value * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${
    String(seconds).padStart(2, "0")
  }.${String(centiseconds).padStart(2, "0")}`;
}

function parseSrt(content: string): SrtCue[] {
  const blocks = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split(/\n{2,}/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) =>
      part.trim().split(/\s+/)[0]
    );
    const start = parseSrtTime(startRaw);
    const end = parseSrtTime(endRaw);
    const text = lines.slice(timingIndex + 1).join(" ").trim();
    if (start === null || end === null || end <= start || !text) continue;

    cues.push({ start, end, text });
  }

  return cues;
}

function escapeAssText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\s+/g, " ")
    .trim();
}

function assColor(value: string): string {
  const clean = cleanHexColor(value, "#F0F0F0").slice(1);
  const red = clean.slice(0, 2);
  const green = clean.slice(2, 4);
  const blue = clean.slice(4, 6);
  return `&H${blue}${green}${red}&`;
}

function assColorTag(value: string): string {
  return `{\\c${assColor(value)}}`;
}

function buildAssKaraoke(
  cues: SrtCue[],
  wordsPerLine: number,
  style: AssStyleOptions,
): string {
  const groupSize = Math.max(1, Math.min(20, wordsPerLine));
  const events: string[] = [];
  const futureColor = "#F0F0F0";

  for (let index = 0; index < cues.length; index += groupSize) {
    const group = cues.slice(index, index + groupSize);
    if (!group.length) continue;

    for (
      let activeIndex = 0;
      activeIndex < group.length;
      activeIndex += 1
    ) {
      const activeCue = group[activeIndex];
      const nextCue = group[activeIndex + 1];
      const start = activeCue.start;
      const end = nextCue?.start ?? activeCue.end;
      if (end <= start) continue;

      const text = group.map((cue, wordIndex) => {
        const color = wordIndex < activeIndex
          ? style.passedColor
          : wordIndex === activeIndex
          ? style.activeColor
          : futureColor;
        return `${assColorTag(color)}${escapeAssText(cue.text)}`;
      }).join(" ");

      events.push(
        `Dialogue: 0,${formatAssTime(start)},${
          formatAssTime(end)
        },Default,,0,0,0,,${text}`,
      );
    }
  }

  const primaryColor = assColor(futureColor);
  const secondaryColor = assColor(style.activeColor);

  return `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${style.fontSize},${primaryColor},${secondaryColor},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,80,80,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

async function createAssKaraokeFromSrt(
  srtPath: string,
  assPath: string,
  wordsPerLine: number,
  style: AssStyleOptions,
): Promise<number> {
  const cues = parseSrt(await Deno.readTextFile(srtPath));
  if (!cues.length) return 1;
  await Deno.writeTextFile(assPath, buildAssKaraoke(cues, wordsPerLine, style));
  return 0;
}

async function processSubtitleAlignment(
  mediaPath: string,
  scriptPath: string,
  language: string,
  model: string,
  outputDir: string,
  options: {
    runner?: Runner;
    log?: LogFn;
    wordsPerCue?: number | null;
    outputMode?: SubtitleOutputMode;
    assStyle?: AssStyleOptions;
  } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const runner = options.runner ?? run;

  if (!(await exists(mediaPath))) {
    log(`Media file not found: ${mediaPath}`);
    return 1;
  }

  if (!(await exists(scriptPath))) {
    log(`Text file not found: ${scriptPath}`);
    return 1;
  }

  await Deno.mkdir(outputDir, { recursive: true });
  const parsed = parse(resolve(mediaPath));
  const outputMode = options.outputMode ?? "srt";
  const stamp = fileTimestamp();
  const output = join(
    outputDir,
    outputMode === "ass-highlight"
      ? `${parsed.name}_highlight_${stamp}.ass`
      : `${parsed.name}_aligned_${stamp}.srt`,
  );

  log("Subtitle alignment");
  log(`Media    : ${mediaPath}`);
  log(`Text     : ${scriptPath}`);
  log(`Language : ${language}`);
  log(`Model    : ${model}`);
  log(
    `Format   : ${
      outputMode === "ass-highlight" ? "ASS word highlight" : "SRT"
    }`,
  );
  if (outputMode === "ass-highlight") {
    const assStyle = options.assStyle ?? defaultAssStyle;
    log(`ASS size : ${assStyle.fontSize}`);
    log(`Active   : ${assStyle.activeColor}`);
    log(`Passed   : ${assStyle.passedColor}`);
  }
  log(`Output   : ${output}`);
  log("");
  log(
    "First run can take a while because Python packages and models are downloaded.",
  );

  let tempOutputDir: string | undefined;
  let alignOutput = output;
  if (outputMode === "ass-highlight") {
    tempOutputDir = await Deno.makeTempDir({ prefix: "svid-subtitle-words-" });
    alignOutput = join(tempOutputDir, "word-timings.srt");
    log("Word highlight: aligning each word first");
  }

  const prepared = await prepareSubtitleScript(
    scriptPath,
    outputMode === "ass-highlight" ? 1 : options.wordsPerCue ?? null,
    log,
  );

  let code = 1;
  try {
    code = await runner(exe("uv"), [
      "tool",
      "run",
      "--python",
      "3.11",
      "--from",
      "sub-align[align]",
      "sub-align",
      mediaPath,
      prepared.path,
      "--language",
      language,
      "--model",
      model,
      "-o",
      alignOutput,
    ]);

    if (code === 0 && outputMode === "ass-highlight") {
      const wordsPerLine = options.wordsPerCue ?? 4;
      code = await createAssKaraokeFromSrt(
        alignOutput,
        output,
        wordsPerLine,
        options.assStyle ?? defaultAssStyle,
      );
      if (code !== 0) log("Could not create ASS highlight subtitles.");
    }
  } finally {
    await prepared.cleanup?.();
    if (tempOutputDir) await removePath(tempOutputDir);
  }

  if (code === 0) {
    log(
      outputMode === "ass-highlight"
        ? `ASS created: ${output}`
        : `SRT created: ${output}`,
    );
  }

  return code;
}

function ytDlpCommonArgs(): string[] {
  return [
    "--progress",
    "--newline",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    "--force-ipv4",
    "--live-from-start",
  ];
}

async function processWebDownload(
  target: string,
  choice: WebAction,
  options: ProcessOptions = {},
): Promise<number> {
  const webTemp = join(
    Deno.env.get("TEMP") ?? appDir,
    `byron_media_${crypto.randomUUID()}`,
  );
  await Deno.mkdir(webTemp, { recursive: true });

  const isTikTok = /tiktok\.com|tiktokv\.com/i.test(target);
  const tiktokUserAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const tiktokFormat = "best[format_id^=h264_]/best[format_id=download]";
  const runner = options.runner ?? run;
  const log = options.log ?? console.log;

  try {
    const args = [
      ...ytDlpCommonArgs(),
      "--ffmpeg-location",
      exe("ffmpeg"),
      "--paths",
      `temp:${webTemp}`,
    ];

    if (options.outputDir) {
      await Deno.mkdir(options.outputDir, { recursive: true });
      args.push("--paths", `home:${options.outputDir}`);
    }

    if (isTikTok) {
      log("[TikTok compatibility mode]");
      log("[TikTok reliable H.264 + AAC mode]");
      args.push("--user-agent", tiktokUserAgent, "-f", tiktokFormat);
    }

    if (!isTikTok && choice === "mp4") {
      args.push(
        "-f",
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format",
        "mp4",
      );
    } else if (!isTikTok && choice === "mkv") {
      args.push(
        "-f",
        "bestvideo+bestaudio/best",
        "--merge-output-format",
        "mkv",
      );
    } else if (!isTikTok && choice === "native") {
      args.push("-f", "bestvideo+bestaudio/best");
    } else if (isTikTok && choice === "mp4") {
      args.push("--merge-output-format", "mp4");
    } else if (isTikTok && choice === "mkv") {
      args.push("--merge-output-format", "mkv");
    }

    if (choice === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    }

    args.push(target);
    return await runner(exe("yt-dlp"), args);
  } finally {
    await removePath(webTemp);
  }
}

type JobStatus = "queued" | "running" | "done" | "failed";
type Job = {
  id: string;
  title: string;
  status: JobStatus;
  logs: string[];
  latestLine: string;
  progress: number | null;
  createdAt: number;
  finishedAt?: number;
};

const jobs = new Map<string, Job>();
let lastUiHeartbeat = Date.now();
let toolsReadyPromise: Promise<boolean> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safeFileName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_");
  const withoutReserved = ascii.replace(/[<>:"/\\|?*]/g, "_");
  const withoutControls = Array.from(withoutReserved).map((char) =>
    char.charCodeAt(0) < 32 ? "_" : char
  ).join("");
  return withoutControls.replace(/\s+/g, " ").trim() || "uploaded-video";
}

function createJob(title: string): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    title,
    status: "queued",
    logs: [],
    latestLine: "",
    progress: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function appendLog(job: Job, line: string) {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const normalized = line.replace(ansiEscape, "").trim();
  if (!normalized) return;

  job.latestLine = normalized;
  const percent = normalized.match(/(?:\[download\]\s*)?(\d+(?:\.\d+)?)%/i);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value)) {
      job.progress = Math.max(0, Math.min(100, value));
    }
  }

  if (
    /\b(100(?:\.0+)?)%/i.test(normalized) ||
    /Task complete|has already been downloaded|Merging formats/i.test(
      normalized,
    )
  ) {
    job.progress = 100;
  }

  job.logs.push(normalized);
  if (job.logs.length > 700) job.logs.splice(0, job.logs.length - 700);
}

function hasActiveJobs(): boolean {
  return [...jobs.values()].some((job) =>
    job.status === "queued" || job.status === "running"
  );
}

function ensureToolsReady(log: LogFn = console.log): Promise<boolean> {
  if (!toolsReadyPromise) {
    toolsReadyPromise = (async () => {
      for (const tool of ["yt-dlp", "ffmpeg", "deno"] as const) {
        log(`Checking ${tool}...`);
        if (!(await ensureTool(tool))) {
          log(`${tool} could not be installed.`);
          return false;
        }
      }

      log("Checking update settings...");
      await maybeUpdateTools();
      log("Tools ready.");
      return true;
    })();
  }

  return toolsReadyPromise;
}

function startJob(job: Job, work: (log: LogFn) => Promise<number>) {
  queueMicrotask(async () => {
    job.status = "running";
    appendLog(job, "Job started.");

    try {
      const code = await work((line) => appendLog(job, line));
      job.status = code === 0 ? "done" : "failed";
      if (code === 0) job.progress = 100;
      appendLog(
        job,
        code === 0 ? "Task complete." : `Task failed with exit code ${code}.`,
      );
    } catch (error) {
      job.status = "failed";
      appendLog(job, error instanceof Error ? error.message : String(error));
    } finally {
      job.finishedAt = Date.now();
    }
  });
}

async function saveUploadedFile(file: File): Promise<string> {
  const uploadDir = join(appDir, "uploads");
  await Deno.mkdir(uploadDir, { recursive: true });

  const target = join(uploadDir, `${Date.now()}-${safeFileName(file.name)}`);
  const output = await Deno.open(target, {
    create: true,
    write: true,
    truncate: true,
  });

  try {
    await file.stream().pipeTo(output.writable);
  } finally {
    try {
      output.close();
    } catch {
      // The writable stream normally owns the close.
    }
  }

  return target;
}

function _legacyWebUi(initialTargets: string[], port: number): string {
  const initialJson = JSON.stringify(initialTargets);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Byron Media Toolkit</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f2;
      --ink: #20211d;
      --muted: #65685f;
      --line: #d9dccf;
      --panel: #ffffff;
      --accent: #0f7b6c;
      --accent-2: #b24a3b;
      --soft: #e9f2ef;
      --shadow: 0 14px 40px rgba(32, 33, 29, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.82);
      backdrop-filter: blur(14px);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .status {
      font-size: 13px;
      color: var(--muted);
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 18px;
      min-width: 0;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 15px;
      letter-spacing: 0;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    input, select, button {
      font: inherit;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--ink);
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      min-height: 38px;
      border: 0;
      border-radius: 6px;
      padding: 8px 13px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-weight: 650;
    }
    button.secondary {
      background: #3d453f;
    }
    button.danger {
      background: var(--accent-2);
    }
    button:disabled {
      opacity: .55;
      cursor: default;
    }
    .drop {
      min-height: 154px;
      border: 2px dashed #9aa79f;
      border-radius: 8px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
      background: var(--soft);
      padding: 16px;
      transition: border-color .15s ease, background .15s ease;
    }
    .drop.active {
      border-color: var(--accent);
      background: #dceee9;
    }
    .pending {
      display: grid;
      gap: 10px;
    }
    .pending-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 148px 86px;
      gap: 10px;
      align-items: end;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .jobs {
      display: grid;
      gap: 12px;
    }
    .job {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }
    .job-head {
      min-height: 42px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
    }
    .badge {
      min-width: 74px;
      text-align: center;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      color: #fff;
      background: #66706a;
    }
    .badge.running { background: #0f7b6c; }
    .badge.done { background: #477a30; }
    .badge.failed { background: #b24a3b; }
    pre {
      margin: 0;
      max-height: 220px;
      overflow: auto;
      padding: 12px;
      background: #181a17;
      color: #e8eadf;
      font: 12px/1.45 Consolas, "Cascadia Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    @media (max-width: 780px) {
      header { padding: 0 16px; }
      main { padding: 16px; }
      .grid, .row, .pending-item { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Byron Media Toolkit</h1>
    <div class="status">Local UI on 127.0.0.1:${port}</div>
  </header>
  <main>
    <div class="grid">
      <section>
        <h2>Download</h2>
        <label>URL
          <input id="url" placeholder="https://..." autocomplete="off">
        </label>
        <label>Format
          <select id="webAction">
            <option value="mp4">MP4 video</option>
            <option value="mkv">MKV video</option>
            <option value="mp3">MP3 audio</option>
            <option value="native">Native source</option>
          </select>
        </label>
        <button id="downloadBtn">Start Download</button>
      </section>

      <section>
        <h2>Local Path</h2>
        <label>File path
          <input id="localPath" placeholder="C:\\\\Videos\\\\clip.mp4" autocomplete="off">
        </label>
        <label>Action
          <select id="localAction">
            <option value="audio">Extract MP3</option>
            <option value="mp4">Re-mux MP4</option>
            <option value="mkv">Re-mux MKV</option>
            <option value="cut">Cut segment</option>
          </select>
        </label>
        <div class="row cutFields">
          <label>Start
            <input id="localStart" placeholder="00:00:05.000">
          </label>
          <label>End
            <input id="localEnd" placeholder="00:00:12.500">
          </label>
        </div>
        <button id="localBtn">Start Local Job</button>
      </section>
    </div>

    <section>
      <h2>Drop Files</h2>
      <div class="row">
        <label>Action
          <select id="dropAction">
            <option value="audio">Extract MP3</option>
            <option value="mp4">Re-mux MP4</option>
            <option value="mkv">Re-mux MKV</option>
            <option value="cut">Cut segment</option>
          </select>
        </label>
        <div class="row cutFields">
          <label>Start
            <input id="dropStart" placeholder="00:00:05.000">
          </label>
          <label>End
            <input id="dropEnd" placeholder="00:00:12.500">
          </label>
        </div>
      </div>
      <div id="drop" class="drop">Drop video or audio files here</div>
    </section>

    <section id="pendingSection" hidden>
      <h2>Dropped On App</h2>
      <div id="pending" class="pending"></div>
    </section>

    <section>
      <h2>Jobs</h2>
      <div id="jobs" class="jobs"></div>
    </section>
  </main>

  <script>
    const initialTargets = ${initialJson};
    const jobsEl = document.querySelector("#jobs");
    const pendingEl = document.querySelector("#pending");
    const pendingSection = document.querySelector("#pendingSection");
    let lastJobsPayload = "";
    const drop = document.querySelector("#drop");

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
      }
      return payload;
    }

    function numberValue(id, fallback = 0) {
      const input = document.querySelector("#" + id);
      const value = Number(input.value);
      return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
    }

    function clampTimeInputs() {
      for (const input of document.querySelectorAll(".time-grid input")) {
        const min = Number(input.min || 0);
        const max = input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = min;
        value = Math.max(min, Math.min(max, Math.floor(value)));
        input.value = String(value);
      }
    }

    function formatTime(hours, minutes, seconds, millis) {
      return String(hours).padStart(2, "0") + ":" +
        String(minutes).padStart(2, "0") + ":" +
        String(seconds).padStart(2, "0") + "." +
        String(millis).padStart(3, "0");
    }

    function timeTotalMs(prefix, point) {
      const hours = numberValue(prefix + point + "Hours");
      const minutes = numberValue(prefix + point + "Minutes");
      const seconds = numberValue(prefix + point + "Seconds");
      const millis = numberValue(prefix + point + "Millis");
      return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
    }

    function timeValue(prefix, point) {
      return formatTime(
        numberValue(prefix + point + "Hours"),
        numberValue(prefix + point + "Minutes"),
        numberValue(prefix + point + "Seconds"),
        numberValue(prefix + point + "Millis")
      );
    }

    function cutValues(prefix) {
      clampTimeInputs();
      return {
        start: timeValue(prefix, "Start"),
        end: timeValue(prefix, "End"),
        startMs: timeTotalMs(prefix, "Start"),
        endMs: timeTotalMs(prefix, "End")
      };
    }

    function setCutStatus(message) {
      document.querySelector("#cutStatus").textContent = message;
    }

    function setConvertStatus(message) {
      document.querySelector("#convertStatus").textContent = message;
    }

    function requireCut(action, values, showMessage = true) {
      if (action !== "cut") return true;
      const ok = values.endMs > values.startMs;
      if (!ok && showMessage) {
        setCutStatus("End time must be greater than start time.");
      }
      if (ok && showMessage) setCutStatus("");
      return ok;
    }

    document.querySelectorAll(".time-grid input").forEach(input => {
      input.addEventListener("wheel", event => {
        event.preventDefault();
        const step = Number(input.step || 1) || 1;
        const min = Number(input.min || 0);
        const max = input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
        const direction = event.deltaY < 0 ? 1 : -1;
        const current = Number(input.value) || 0;
        input.value = String(Math.max(min, Math.min(max, current + direction * step)));
      }, { passive: false });
    });

    for (const eventName of ["dragover", "drop"]) {
      document.addEventListener(eventName, event => {
        event.preventDefault();
      });
    }

    function pathFromDropText(text) {
      const first = text.split(/\\r?\\n/).map(line => line.trim()).find(Boolean);
      if (!first) return "";
      try {
        if (first.startsWith("file://")) {
          const url = new URL(first);
          let path = decodeURIComponent(url.pathname);
          if (/^\\/[A-Za-z]:\\//.test(path)) path = path.slice(1);
          return path.replaceAll("/", "\\\\");
        }
      } catch {
        return "";
      }
      return /^[A-Za-z]:\\\\/.test(first) ? first : "";
    }

    document.querySelector("#downloadBtn").addEventListener("click", async () => {
      const target = document.querySelector("#url").value.trim();
      const action = document.querySelector("#webAction").value;
      if (!target) return;
      await postJson("/api/jobs", { kind: "web", target, action });
      document.querySelector("#url").value = "";
      await refreshJobs();
    });

    document.querySelector("#localBtn").addEventListener("click", async () => {
      const target = document.querySelector("#localPath").value.trim();
      const action = document.querySelector("#localAction").value;
      const cut = cutValues("local");
      if (!target || !requireCut(action, cut)) return;
      await postJson("/api/jobs", { kind: "path", target, action, ...cut });
      await refreshJobs();
    });

    for (const eventName of ["dragenter", "dragover"]) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.add("active");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.remove("active");
      });
    }
    drop.addEventListener("drop", async event => {
      const action = document.querySelector("#dropAction").value;
      const cut = cutValues("drop");
      if (!requireCut(action, cut)) return;

      for (const file of event.dataTransfer.files) {
        const form = new FormData();
        form.append("file", file);
        form.append("action", action);
        form.append("start", cut.start);
        form.append("end", cut.end);
        await fetch("/api/upload", { method: "POST", body: form });
      }
      await refreshJobs();
    });

    function renderPending() {
      if (!initialTargets.length) return;
      pendingSection.hidden = false;
      pendingEl.innerHTML = "";
      initialTargets.forEach(target => {
        const item = document.createElement("div");
        item.className = "pending-item";
        const isUrl = /^https?:\\/\\//i.test(target);
        item.innerHTML = \`
          <div>
            <div class="path" title="\${target.replaceAll('"', "&quot;")}">\${target}</div>
          </div>
          <label>Action
            <select>
              \${isUrl
                ? '<option value="mp4">MP4 video</option><option value="mkv">MKV video</option><option value="mp3">MP3 audio</option><option value="native">Native source</option>'
                : '<option value="audio">Extract MP3</option><option value="mp4">Re-mux MP4</option><option value="mkv">Re-mux MKV</option><option value="cut">Cut segment</option>'}
            </select>
          </label>
          <button>Start</button>
        \`;
        item.querySelector("button").addEventListener("click", async () => {
          const action = item.querySelector("select").value;
          await postJson("/api/jobs", { kind: isUrl ? "web" : "path", target, action });
          item.remove();
          if (!pendingEl.children.length) pendingSection.hidden = true;
          await refreshJobs();
        });
        pendingEl.append(item);
      });
    }

    function renderJobs(jobs) {
      jobsEl.innerHTML = "";
      if (!jobs.length) {
        jobsEl.innerHTML = "<div class='status'>No jobs yet.</div>";
        return;
      }

      for (const job of jobs) {
        const el = document.createElement("div");
        el.className = "job";
        el.innerHTML = \`
          <div class="job-head">
            <div class="path" title="\${job.title.replaceAll('"', "&quot;")}">\${job.title}</div>
            <div class="badge \${job.status}">\${job.status}</div>
          </div>
          <pre>\${job.logs.join("\\n")}</pre>
        \`;
        jobsEl.append(el);
      }
    }

    async function refreshJobs() {
      const response = await fetch("/api/jobs");
      const data = await response.json();
      renderJobs(data.jobs);
    }

    function heartbeat() {
      fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }

    renderPending();
    heartbeat();
    refreshJobs();
    setInterval(heartbeat, 1500);
    setInterval(refreshJobs, 1000);
  </script>
</body>
</html>`;
}

function webUi(initialTargets: string[]): string {
  const initialJson = JSON.stringify(initialTargets);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101010;
      --panel: #191919;
      --panel-2: #202020;
      --ink: #f0eee9;
      --muted: #9d9991;
      --line: #303030;
      --accent: #7b2331;
      --accent-2: #a13647;
      --soft: #26171a;
      --shadow: 0 18px 48px rgba(0,0,0,.34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 760px;
      background: var(--bg);
      color: var(--ink);
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    header {
      height: 58px;
      display: flex;
      align-items: center;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: #151515;
    }
    h1 {
      margin: 0;
      font-size: 17px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .title-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .version {
      color: var(--accent-soft);
      font-size: 12px;
      font-weight: 700;
    }
    .tagline {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    main {
      width: min(940px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 12px 0;
      display: grid;
      gap: 10px;
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 7px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #151515;
    }
    .tab-btn {
      min-height: 34px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-weight: 650;
    }
    .tab-btn.active {
      background: var(--soft);
      border-color: #4b252b;
      color: var(--ink);
    }
    section {
      min-width: 0;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
      letter-spacing: 0;
    }
    label {
      display: grid;
      gap: 5px;
      margin-bottom: 9px;
      color: var(--muted);
      font-size: 12px;
    }
    input, select, button { font: inherit; }
    input, select {
      width: 100%;
      min-height: 34px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #101010;
      color: var(--ink);
    }
    input[type="color"] {
      padding: 3px;
      cursor: pointer;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .command-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .secondary-btn {
      background: #2a2a2a;
      color: var(--muted);
    }
    .secondary-btn:hover {
      background: #343434;
      color: var(--ink);
    }
    .support-box {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }
    .support-title {
      margin-bottom: 6px;
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
    }
    .support-copy {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .support-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .thanks-list {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .thanks-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
    }
    .thanks-name {
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
    }
    .thanks-role {
      color: var(--muted);
      font-size: 12px;
    }
    .support-link {
      min-height: 34px;
      display: grid;
      place-items: center;
      padding: 7px 10px;
      border-radius: 6px;
      background: #0070ba;
      color: #fff;
      text-decoration: none;
      text-align: center;
      font-size: 12px;
      font-weight: 700;
    }
    .support-link:hover {
      background: #003087;
    }
    .tool-link {
      min-height: 30px;
      display: grid;
      place-items: center;
      padding: 6px 9px;
      border-radius: 6px;
      background: #2a2a2a;
      color: var(--ink);
      text-decoration: none;
      text-align: center;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .tool-link:hover {
      background: #343434;
    }
    .tool-link.donate {
      background: #7b2331;
      color: #fff;
    }
    .tool-link.donate:hover {
      background: #9f3543;
    }
    .source-row {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 10px;
      align-items: stretch;
      margin-bottom: 10px;
    }
    .path-input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }
    .path-input-row button {
      min-width: 86px;
    }
    .time-box {
      display: grid;
      gap: 7px;
      margin-bottom: 10px;
    }
    .time-box-title {
      color: var(--muted);
      font-size: 12px;
    }
    .time-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .time-grid label {
      margin-bottom: 0;
    }
    .time-grid input {
      text-align: center;
    }
    button {
      min-height: 34px;
      padding: 7px 12px;
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-weight: 650;
    }
    button:hover { background: var(--accent-2); }
    .drop {
      min-height: 104px;
      display: grid;
      place-items: center;
      margin-top: 10px;
      padding: 12px;
      border: 1px dashed #68414a;
      border-radius: 8px;
      background: var(--soft);
      color: var(--muted);
      text-align: center;
      transition: border-color .15s ease, background .15s ease;
    }
    .drop.active {
      border-color: var(--accent-2);
      background: #311b20;
    }
    .drop.small {
      min-height: 68px;
      margin-top: 0;
      padding: 10px;
      font-size: 13px;
    }
    .pending, .jobs {
      display: grid;
      gap: 8px;
    }
    .pending-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 140px 76px;
      gap: 8px;
      align-items: end;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
    }
    .status.error {
      color: #e19aa4;
      margin-top: 8px;
    }
    .job {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
    }
    .job-head {
      min-height: 36px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
    }
    .badge {
      min-width: 68px;
      padding: 3px 7px;
      border-radius: 999px;
      background: #555;
      color: #fff;
      text-align: center;
      font-size: 12px;
    }
    .badge.running { background: #7b2331; }
    .badge.done { background: #3f6b42; }
    .badge.failed { background: #9f3543; }
    .job-progress {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
    }
    .progress-track {
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: #101010;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: var(--accent-2);
      transition: width .2s ease;
    }
    .progress-fill.indeterminate {
      width: 38%;
      animation: slide-progress 1.1s ease-in-out infinite;
    }
    @keyframes slide-progress {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(270%); }
    }
    .latest-line {
      min-height: 17px;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    pre {
      max-height: 142px;
      overflow: auto;
      margin: 0;
      padding: 10px;
      background: #0b0b0b;
      color: #dfd9d2;
      font: 12px/1.45 Consolas, "Cascadia Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    pre[hidden] { display: none; }
    .log-toggle {
      min-height: 30px;
      margin: 8px 10px 10px;
      padding: 5px 10px;
      background: #2a2a2a;
      color: var(--muted);
      font-size: 12px;
    }
    .log-toggle:hover {
      background: #343434;
      color: var(--ink);
    }
    footer {
      color: var(--muted);
      font-size: 12px;
      text-align: right;
      padding: 0 2px 2px;
    }
    @media (max-width: 780px) {
      body { min-width: 0; }
      main { width: calc(100vw - 20px); }
      .tabs, .row, .source-row, .pending-item, .support-grid, .thanks-item { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="title-row">
        <h1>${APP_NAME}</h1>
        <span class="version">v${APP_VERSION}</span>
      </div>
      <div class="tagline">${APP_TAGLINE}</div>
    </div>
  </header>
  <main>
    <nav class="tabs" aria-label="Tools">
      <button class="tab-btn active" data-tab="download">Download</button>
      <button class="tab-btn" data-tab="cut">Cut</button>
      <button class="tab-btn" data-tab="convert">Convert</button>
      <button class="tab-btn" data-tab="subtitles">Subtitles</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
    </nav>

    <section id="download" class="tab-panel active">
      <h2>Download</h2>
      <label>URL
        <input id="url" placeholder="https://..." autocomplete="off">
      </label>
      <label>Format
        <select id="webAction">
          <option value="mp4">MP4 video</option>
          <option value="mkv">MKV video</option>
          <option value="mp3">MP3 audio</option>
          <option value="native">Native source</option>
        </select>
      </label>
      <div class="command-row">
        <button id="downloadBtn">Start Download</button>
        <button class="secondary-btn" data-open-folder="downloads">Open Folder</button>
      </div>
    </section>

    <section id="cut" class="tab-panel">
      <h2>Cut</h2>
      <div class="source-row">
        <div id="cutDrop" class="drop small">Click or drop video here</div>
        <label>File path
          <div class="path-input-row">
            <input id="cutPath" placeholder="C:\\\\Videos\\\\clip.mp4" autocomplete="off">
            <button id="cutBrowseBtn" class="secondary-btn" type="button">Browse</button>
          </div>
        </label>
      </div>
      <div class="row">
        <div class="time-box">
          <div class="time-box-title">Start</div>
          <div class="time-grid">
            <label>Hours<input id="cutStartHours" type="number" min="0" step="1" value="0"></label>
            <label>Minutes<input id="cutStartMinutes" type="number" min="0" max="59" step="1" value="0"></label>
            <label>Seconds<input id="cutStartSeconds" type="number" min="0" max="59" step="1" value="0"></label>
            <label>Millis<input id="cutStartMillis" type="number" min="0" max="999" step="10" value="0"></label>
          </div>
        </div>
        <div class="time-box">
          <div class="time-box-title">End</div>
          <div class="time-grid">
            <label>Hours<input id="cutEndHours" type="number" min="0" step="1" value="0"></label>
            <label>Minutes<input id="cutEndMinutes" type="number" min="0" max="59" step="1" value="0"></label>
            <label>Seconds<input id="cutEndSeconds" type="number" min="0" max="59" step="1" value="0"></label>
            <label>Millis<input id="cutEndMillis" type="number" min="0" max="999" step="10" value="0"></label>
          </div>
        </div>
      </div>
      <div class="command-row">
        <button id="cutBtn">Cut Video</button>
        <button class="secondary-btn" data-open-folder="cuts">Open Folder</button>
      </div>
      <div id="cutStatus" class="status error"></div>
    </section>

    <section id="convert" class="tab-panel">
      <h2>Convert</h2>
      <div class="source-row">
        <div id="convertDrop" class="drop small">Click or drop file here</div>
        <label>File path
          <div class="path-input-row">
            <input id="convertPath" placeholder="C:\\\\Videos\\\\clip.mp4" autocomplete="off">
            <button id="convertBrowseBtn" class="secondary-btn" type="button">Browse</button>
          </div>
        </label>
      </div>
      <label>Action
        <select id="convertAction">
          <option value="audio">Extract MP3</option>
          <option value="mp4">MP4 video</option>
          <option value="mkv">MKV video</option>
        </select>
      </label>
      <label>Quality
        <select id="convertQuality">
          <option value="copy">Same quality / fast</option>
          <option value="high">High quality</option>
          <option value="balanced">Balanced</option>
          <option value="small">Small file</option>
        </select>
      </label>
      <div class="command-row">
        <button id="convertBtn">Start Convert</button>
        <button class="secondary-btn" data-open-folder="converts">Open Folder</button>
      </div>
      <div id="convertStatus" class="status error"></div>
    </section>

    <section id="subtitles" class="tab-panel">
      <h2>Subtitles</h2>
      <div class="source-row">
        <div id="subtitleMediaDrop" class="drop small">Click or drop video/audio here</div>
        <label>Video or audio path
          <div class="path-input-row">
            <input id="subtitleMediaPath" placeholder="C:\\\\Videos\\\\speech.mp4" autocomplete="off">
            <button id="subtitleMediaBrowseBtn" class="secondary-btn" type="button">Browse</button>
          </div>
        </label>
      </div>
      <div class="source-row">
        <div id="subtitleTextDrop" class="drop small">Click or drop text here</div>
        <label>Corrected text path
          <div class="path-input-row">
            <input id="subtitleTextPath" placeholder="C:\\\\Videos\\\\script.txt" autocomplete="off">
            <button id="subtitleTextBrowseBtn" class="secondary-btn" type="button">Browse</button>
          </div>
        </label>
      </div>
      <div class="row">
        <label>Language code
          <input id="subtitleLanguage" value="el" autocomplete="off">
        </label>
        <label>Whisper model
          <select id="subtitleModel">
            <option value="tiny">Tiny</option>
            <option value="base">Base</option>
            <option value="small" selected>Small</option>
            <option value="medium">Medium</option>
            <option value="large-v3">Large v3</option>
          </select>
        </label>
      </div>
      <label>Subtitle length
        <select id="subtitleWordsPerCue">
          <option value="keep">Keep text lines</option>
          <option value="1">1 word</option>
          <option value="2">2 words</option>
          <option value="3">3 words</option>
          <option value="4" selected>4 words</option>
          <option value="5">5 words</option>
          <option value="6">6 words</option>
          <option value="7">7 words</option>
          <option value="8">8 words</option>
          <option value="9">9 words</option>
          <option value="10">10 words</option>
          <option value="11">11 words</option>
          <option value="12">12 words</option>
          <option value="13">13 words</option>
          <option value="14">14 words</option>
          <option value="15">15 words</option>
          <option value="16">16 words</option>
          <option value="17">17 words</option>
          <option value="18">18 words</option>
          <option value="19">19 words</option>
          <option value="20">20 words</option>
        </select>
      </label>
      <label>Output
        <select id="subtitleOutputMode">
          <option value="srt" selected>SRT</option>
          <option value="ass-highlight">ASS word highlight</option>
        </select>
      </label>
      <div class="row">
        <label>ASS font size
          <input id="subtitleAssFontSize" type="number" min="16" max="96" step="1" value="32">
        </label>
        <label>Active word color
          <input id="subtitleAssActiveColor" type="color" value="#d33360">
        </label>
      </div>
      <label>Passed words color
        <input id="subtitleAssPassedColor" type="color" value="#f0f0f0">
      </label>
      <div class="command-row">
        <button id="subtitleBtn">Start Alignment</button>
        <button class="secondary-btn" data-open-folder="subtitles">Open Folder</button>
      </div>
      <div id="subtitleStatus" class="status error"></div>
    </section>

    <section id="settings" class="tab-panel">
      <h2>Settings</h2>
      <label>Svid update check
        <select id="updateSvid">
          <option value="3d">Every 3 days</option>
          <option value="7d">Every week</option>
          <option value="30d">Every month</option>
          <option value="90d">Every 3 months</option>
          <option value="365d">Every year</option>
          <option value="never">Never</option>
        </select>
      </label>
      <div class="command-row">
        <button id="checkSvidUpdateBtn" class="secondary-btn">Check for Svid update</button>
      </div>
      <div id="svidUpdateStatus" class="status"></div>
      <div class="row">
        <label>yt-dlp update check
          <select id="updateYtdlp">
            <option value="3d">Every 3 days</option>
            <option value="7d">Every week</option>
            <option value="30d">Every month</option>
            <option value="90d">Every 3 months</option>
            <option value="365d">Every year</option>
            <option value="never">Never</option>
          </select>
        </label>
        <label>ffmpeg update check
          <select id="updateFfmpeg">
            <option value="3d">Every 3 days</option>
            <option value="7d">Every week</option>
            <option value="30d">Every month</option>
            <option value="90d">Every 3 months</option>
            <option value="365d">Every year</option>
            <option value="never">Never</option>
          </select>
        </label>
      </div>
      <label>deno update check
        <select id="updateDeno">
          <option value="3d">Every 3 days</option>
          <option value="7d">Every week</option>
          <option value="30d">Every month</option>
          <option value="90d">Every 3 months</option>
          <option value="365d">Every year</option>
          <option value="never">Never</option>
        </select>
      </label>
      <label>Downloads folder
        <input id="downloadsDir" autocomplete="off">
      </label>
      <label>Cuts folder
        <input id="cutsDir" autocomplete="off">
      </label>
      <label>Converts folder
        <input id="convertsDir" autocomplete="off">
      </label>
      <label>Subtitles folder
        <input id="subtitlesDir" autocomplete="off">
      </label>
      <button id="saveSettingsBtn">Save Settings</button>
      <div id="settingsStatus" class="status"></div>
      <div class="support-box">
        <div class="support-title">Support development</div>
        <p class="support-copy">
          Enjoying Svid? A small donation helps keep it maintained and free.
        </p>
        <div class="support-grid">
          <a class="support-link" href="https://www.paypal.com/ncp/payment/LDBFB3RRB3E9J" target="_blank" rel="noopener noreferrer">Buy me a coffee (EUR 5)</a>
          <a class="support-link" href="https://www.paypal.com/ncp/payment/G5RNTC3UF58VU" target="_blank" rel="noopener noreferrer">Buy me a beer (EUR 10)</a>
          <a class="support-link" href="https://www.paypal.com/ncp/payment/4NP9RNUYRFRFA" target="_blank" rel="noopener noreferrer">Buy me a meal (EUR 15)</a>
        </div>
      </div>
      <div class="support-box">
        <div class="support-title">Thanks & open source support</div>
        <p class="support-copy">
          This app is powered by excellent open-source projects. If you find them useful, consider visiting their pages or supporting them directly.
        </p>
        <div class="thanks-list">
          <div class="thanks-item">
            <div>
              <div class="thanks-name">yt-dlp</div>
              <div class="thanks-role">Video download engine</div>
            </div>
            <a class="tool-link" href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link donate" href="https://github.com/yt-dlp/yt-dlp/blob/master/Collaborators.md" target="_blank" rel="noopener noreferrer">Support</a>
          </div>
          <div class="thanks-item">
            <div>
              <div class="thanks-name">FFmpeg</div>
              <div class="thanks-role">Video/audio processing</div>
            </div>
            <a class="tool-link" href="https://ffmpeg.org/" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link donate" href="https://ffmpeg.org/donations.html" target="_blank" rel="noopener noreferrer">Donate</a>
          </div>
          <div class="thanks-item">
            <div>
              <div class="thanks-name">Deno</div>
              <div class="thanks-role">Portable app backend/runtime</div>
            </div>
            <a class="tool-link" href="https://deno.com/" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link donate" href="https://github.com/sponsors/denoland" target="_blank" rel="noopener noreferrer">Sponsor</a>
          </div>
          <div class="thanks-item">
            <div>
              <div class="thanks-name">sub-align</div>
              <div class="thanks-role">Subtitle alignment</div>
            </div>
            <a class="tool-link" href="https://pypi.org/project/sub-align/" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link" href="https://github.com/m-bain/whisperX" target="_blank" rel="noopener noreferrer">WhisperX</a>
          </div>
          <div class="thanks-item">
            <div>
              <div class="thanks-name">uv</div>
              <div class="thanks-role">Python tool runner</div>
            </div>
            <a class="tool-link" href="https://github.com/astral-sh/uv" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link" href="https://docs.astral.sh/uv/" target="_blank" rel="noopener noreferrer">Docs</a>
          </div>
          <div class="thanks-item">
            <div>
              <div class="thanks-name">Microsoft Edge WebView2</div>
              <div class="thanks-role">Native app window web runtime</div>
            </div>
            <a class="tool-link" href="https://developer.microsoft.com/microsoft-edge/webview2/" target="_blank" rel="noopener noreferrer">Project</a>
            <a class="tool-link" href="https://learn.microsoft.com/microsoft-edge/webview2/" target="_blank" rel="noopener noreferrer">Docs</a>
          </div>
        </div>
      </div>
    </section>

    <section id="pendingSection" hidden>
      <h2>Dropped On App</h2>
      <div id="pending" class="pending"></div>
    </section>

    <section>
      <h2>Jobs</h2>
      <div id="jobs" class="jobs"></div>
    </section>

    <footer>Made by Byron Iniotakis</footer>
  </main>

  <script>
    const initialTargets = ${initialJson};
    const jobsEl = document.querySelector("#jobs");
    const pendingEl = document.querySelector("#pending");
    const pendingSection = document.querySelector("#pendingSection");
    const openLogs = new Set();
    let lastJobsPayload = "";

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
      }
      return payload;
    }

    function numberValue(id, fallback = 0) {
      const input = document.querySelector("#" + id);
      const value = Number(input.value);
      return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
    }

    function clampTimeInputs() {
      for (const input of document.querySelectorAll(".time-grid input")) {
        const min = Number(input.min || 0);
        const max = input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = min;
        value = Math.max(min, Math.min(max, Math.floor(value)));
        input.value = String(value);
      }
    }

    function formatTime(hours, minutes, seconds, millis) {
      return String(hours).padStart(2, "0") + ":" +
        String(minutes).padStart(2, "0") + ":" +
        String(seconds).padStart(2, "0") + "." +
        String(millis).padStart(3, "0");
    }

    function timeTotalMs(prefix, point) {
      const hours = numberValue(prefix + point + "Hours");
      const minutes = numberValue(prefix + point + "Minutes");
      const seconds = numberValue(prefix + point + "Seconds");
      const millis = numberValue(prefix + point + "Millis");
      return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
    }

    function timeValue(prefix, point) {
      return formatTime(
        numberValue(prefix + point + "Hours"),
        numberValue(prefix + point + "Minutes"),
        numberValue(prefix + point + "Seconds"),
        numberValue(prefix + point + "Millis")
      );
    }

    function cutValues(prefix) {
      clampTimeInputs();
      return {
        start: timeValue(prefix, "Start"),
        end: timeValue(prefix, "End"),
        startMs: timeTotalMs(prefix, "Start"),
        endMs: timeTotalMs(prefix, "End")
      };
    }

    function setCutStatus(message) {
      document.querySelector("#cutStatus").textContent = message;
    }

    function setConvertStatus(message) {
      document.querySelector("#convertStatus").textContent = message;
    }

    function setSubtitleStatus(message) {
      document.querySelector("#subtitleStatus").textContent = message;
    }

    function requireCut(action, values, showMessage = true) {
      if (action !== "cut") return true;
      const ok = values.endMs > values.startMs;
      if (!ok && showMessage) setCutStatus("End time must be greater than start time.");
      if (ok && showMessage) setCutStatus("");
      return ok;
    }

    document.querySelectorAll(".time-grid input").forEach(input => {
      input.addEventListener("wheel", event => {
        event.preventDefault();
        const step = Number(input.step || 1) || 1;
        const min = Number(input.min || 0);
        const max = input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
        const direction = event.deltaY < 0 ? 1 : -1;
        const current = Number(input.value) || 0;
        input.value = String(Math.max(min, Math.min(max, current + direction * step)));
      }, { passive: false });
    });

    async function loadSettings() {
      const response = await fetch("/api/settings");
      const settings = await response.json();
      document.querySelector("#updateSvid").value = settings.updateIntervals.svid;
      document.querySelector("#updateYtdlp").value = settings.updateIntervals["yt-dlp"];
      document.querySelector("#updateFfmpeg").value = settings.updateIntervals.ffmpeg;
      document.querySelector("#updateDeno").value = settings.updateIntervals.deno;
      document.querySelector("#downloadsDir").value = settings.outputDirs.downloads;
      document.querySelector("#cutsDir").value = settings.outputDirs.cuts;
      document.querySelector("#convertsDir").value = settings.outputDirs.converts;
      document.querySelector("#subtitlesDir").value = settings.outputDirs.subtitles;
    }

    document.querySelector("#saveSettingsBtn").addEventListener("click", async () => {
      const status = document.querySelector("#settingsStatus");
      await postJson("/api/settings", {
        updateIntervals: {
          svid: document.querySelector("#updateSvid").value,
          "yt-dlp": document.querySelector("#updateYtdlp").value,
          ffmpeg: document.querySelector("#updateFfmpeg").value,
          deno: document.querySelector("#updateDeno").value
        },
        outputDirs: {
          downloads: document.querySelector("#downloadsDir").value,
          cuts: document.querySelector("#cutsDir").value,
          converts: document.querySelector("#convertsDir").value,
          subtitles: document.querySelector("#subtitlesDir").value
        }
      });
      status.textContent = "Saved.";
      setTimeout(() => { status.textContent = ""; }, 1600);
    });

    async function checkSvidUpdate(scheduled = false) {
      const status = document.querySelector("#svidUpdateStatus");
      if (!scheduled) status.textContent = "Checking Svid update...";
      try {
        const result = await postJson("/api/svid-update/check", { scheduled });
        if (!result.checked) return;
        if (!result.updateAvailable) {
          status.textContent = "Svid is up to date.";
          return;
        }

        status.textContent = "Svid " + result.latestVersion + " is available.";
        if (scheduled) return;

        if (!confirm("Svid " + result.latestVersion + " is available. Download and run the installer now?")) {
          return;
        }

        status.textContent = "Downloading Svid installer...";
        const install = await postJson("/api/svid-update/install", {});
        status.textContent = install.started
          ? "Installer started. Follow the setup window."
          : "Svid is up to date.";
      } catch (error) {
        if (!scheduled) status.textContent = error.message || String(error);
      }
    }

    document.querySelector("#checkSvidUpdateBtn").addEventListener("click", async () => {
      await checkSvidUpdate(false);
    });

    document.querySelectorAll("[data-open-folder]").forEach(button => {
      button.addEventListener("click", async () => {
        await postJson("/api/open-folder", { key: button.dataset.openFolder });
      });
    });

    document.querySelectorAll(".tab-btn").forEach(button => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(item => item.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(item => item.classList.remove("active"));
        button.classList.add("active");
        document.querySelector("#" + button.dataset.tab).classList.add("active");
      });
    });

    document.querySelector("#downloadBtn").addEventListener("click", async () => {
      const target = document.querySelector("#url").value.trim();
      const action = document.querySelector("#webAction").value;
      if (!target) return;
      await postJson("/api/jobs", { kind: "web", target, action });
      document.querySelector("#url").value = "";
      await refreshJobs();
    });

    document.querySelector("#cutBtn").addEventListener("click", async () => {
      const target = document.querySelector("#cutPath").value.trim();
      const cut = cutValues("cut");
      if (!target) {
        setCutStatus("Choose a video file first.");
        return;
      }
      if (!requireCut("cut", cut)) return;
      await postJson("/api/jobs", { kind: "path", target, action: "cut", ...cut });
      await refreshJobs();
    });

    async function browseCutFile(fallbackMessage = "") {
      if (fallbackMessage) setCutStatus(fallbackMessage);
      const result = await postJson("/api/browse-file", {});
      if (result.path) {
        document.querySelector("#cutPath").value = result.path;
        setCutStatus("Video selected. Set times, then press Cut Video.");
      } else if (fallbackMessage) {
        setCutStatus("");
      }
    }

    document.querySelector("#cutBrowseBtn").addEventListener("click", () => {
      browseCutFile();
    });

    function setupCutFileDrop() {
      const zone = document.querySelector("#cutDrop");
      zone.addEventListener("click", () => browseCutFile());
      for (const eventName of ["dragenter", "dragover"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.add("active");
        });
      }
      for (const eventName of ["dragleave", "drop"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.remove("active");
        });
      }
      zone.addEventListener("drop", async event => {
        const files = Array.from(event.dataTransfer.files || []);
        if (!files.length) {
          const droppedPath = pathFromDropText(
            event.dataTransfer.getData("text/uri-list") ||
            event.dataTransfer.getData("text/plain") ||
            ""
          );
          if (droppedPath) {
            document.querySelector("#cutPath").value = droppedPath;
            setCutStatus("Video selected. Set times, then press Cut Video.");
            return;
          }
          setCutStatus("No file was received. Try dropping from Windows Explorer.");
          return;
        }

        await browseCutFile("Windows hides paths from this drop. Pick the same video once.");
      });
    }

    async function handleNativeFileDrop(paths) {
      if (!Array.isArray(paths) || !paths.length) return;
      const activeTab = document.querySelector(".tab-panel.active")?.id;

      if (activeTab === "cut") {
        document.querySelector("#cutPath").value = paths[0];
        setCutStatus("Video selected. Set times, then press Cut Video.");
        return;
      }

      if (activeTab === "convert") {
        document.querySelector("#convertPath").value = paths[0];
        setConvertStatus("File selected. Choose action, then press Start Convert.");
        return;
      }

      if (activeTab === "subtitles") {
        const path = paths[0];
        if (/\\.txt$/i.test(path)) {
          document.querySelector("#subtitleTextPath").value = path;
          setSubtitleStatus("Text selected.");
        } else {
          document.querySelector("#subtitleMediaPath").value = path;
          setSubtitleStatus("Media selected.");
        }
      }
    }

    if (window.chrome?.webview) {
      window.chrome.webview.addEventListener("message", event => {
        if (event.data?.kind === "native-file-drop") {
          handleNativeFileDrop(event.data.paths);
        }
      });
    }

    document.querySelector("#convertBtn").addEventListener("click", async () => {
      const target = document.querySelector("#convertPath").value.trim();
      const action = document.querySelector("#convertAction").value;
      const quality = document.querySelector("#convertQuality").value;
      if (!target) {
        setConvertStatus("Choose a file first.");
        return;
      }
      try {
        setConvertStatus("Starting convert...");
        await postJson("/api/jobs", { kind: "path", target, action, quality });
        setConvertStatus("Convert job started.");
        await refreshJobs();
      } catch (error) {
        setConvertStatus(error instanceof Error ? error.message : String(error));
      }
    });

    function updateConvertQualityLabels() {
      const action = document.querySelector("#convertAction").value;
      const quality = document.querySelector("#convertQuality");
      const current = quality.value;
      if (action === "audio") {
        quality.innerHTML = \`
          <option value="copy">Best MP3</option>
          <option value="high">320 kbps</option>
          <option value="balanced">192 kbps</option>
          <option value="small">128 kbps</option>
        \`;
      } else {
        quality.innerHTML = \`
          <option value="copy">Same quality / fast</option>
          <option value="high">High quality</option>
          <option value="balanced">Balanced</option>
          <option value="small">Small file</option>
        \`;
      }
      quality.value = ["copy", "high", "balanced", "small"].includes(current)
        ? current
        : "copy";
    }

    document.querySelector("#convertAction").addEventListener("change", updateConvertQualityLabels);
    updateConvertQualityLabels();

    async function browseConvertFile(fallbackMessage = "") {
      if (fallbackMessage) setConvertStatus(fallbackMessage);
      const result = await postJson("/api/browse-file", {});
      if (result.path) {
        document.querySelector("#convertPath").value = result.path;
        setConvertStatus("File selected. Choose action, then press Start Convert.");
      } else if (fallbackMessage) {
        setConvertStatus("");
      }
    }

    document.querySelector("#convertBrowseBtn").addEventListener("click", () => {
      browseConvertFile();
    });

    async function browseSubtitleMediaFile(fallbackMessage = "") {
      if (fallbackMessage) setSubtitleStatus(fallbackMessage);
      const result = await postJson("/api/browse-file", { kind: "media" });
      if (result.path) {
        document.querySelector("#subtitleMediaPath").value = result.path;
        setSubtitleStatus("Media selected.");
      } else if (fallbackMessage) {
        setSubtitleStatus("");
      }
    }

    async function browseSubtitleTextFile(fallbackMessage = "") {
      if (fallbackMessage) setSubtitleStatus(fallbackMessage);
      const result = await postJson("/api/browse-file", { kind: "text" });
      if (result.path) {
        document.querySelector("#subtitleTextPath").value = result.path;
        setSubtitleStatus("Text selected.");
      } else if (fallbackMessage) {
        setSubtitleStatus("");
      }
    }

    document.querySelector("#subtitleMediaBrowseBtn").addEventListener("click", () => {
      browseSubtitleMediaFile();
    });

    document.querySelector("#subtitleTextBrowseBtn").addEventListener("click", () => {
      browseSubtitleTextFile();
    });

    function setupPathDrop(zoneId, inputId, fallback) {
      const zone = document.querySelector("#" + zoneId);
      zone.addEventListener("click", fallback);
      for (const eventName of ["dragenter", "dragover"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.add("active");
        });
      }
      for (const eventName of ["dragleave", "drop"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.remove("active");
        });
      }
      zone.addEventListener("drop", async event => {
        const droppedPath = pathFromDropText(
          event.dataTransfer.getData("text/uri-list") ||
          event.dataTransfer.getData("text/plain") ||
          ""
        );
        if (droppedPath) {
          document.querySelector("#" + inputId).value = droppedPath;
          setSubtitleStatus("File selected.");
          return;
        }
        await fallback("Windows hides paths from this drop. Pick the same file once.");
      });
    }

    setupPathDrop("subtitleMediaDrop", "subtitleMediaPath", browseSubtitleMediaFile);
    setupPathDrop("subtitleTextDrop", "subtitleTextPath", browseSubtitleTextFile);

    document.querySelector("#subtitleBtn").addEventListener("click", async () => {
      const mediaPath = document.querySelector("#subtitleMediaPath").value.trim();
      const scriptPath = document.querySelector("#subtitleTextPath").value.trim();
      const language = document.querySelector("#subtitleLanguage").value.trim() || "el";
      const model = document.querySelector("#subtitleModel").value;
      const wordsPerCue = document.querySelector("#subtitleWordsPerCue").value;
      const outputMode = document.querySelector("#subtitleOutputMode").value;
      const assFontSize = document.querySelector("#subtitleAssFontSize").value;
      const assActiveColor = document.querySelector("#subtitleAssActiveColor").value;
      const assPassedColor = document.querySelector("#subtitleAssPassedColor").value;
      if (!mediaPath || !scriptPath) {
        setSubtitleStatus("Choose media and text files first.");
        return;
      }
      try {
        setSubtitleStatus("Starting subtitle alignment...");
        await postJson("/api/jobs", {
          kind: "subtitle",
          mediaPath,
          scriptPath,
          language,
          model,
          wordsPerCue,
          outputMode,
          assFontSize,
          assActiveColor,
          assPassedColor
        });
        setSubtitleStatus("Subtitle job started.");
        await refreshJobs();
      } catch (error) {
        setSubtitleStatus(error instanceof Error ? error.message : String(error));
      }
    });

    function setupConvertFileDrop() {
      const zone = document.querySelector("#convertDrop");
      zone.addEventListener("click", () => browseConvertFile());
      for (const eventName of ["dragenter", "dragover"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.add("active");
        });
      }
      for (const eventName of ["dragleave", "drop"]) {
        zone.addEventListener(eventName, event => {
          event.preventDefault();
          zone.classList.remove("active");
        });
      }
      zone.addEventListener("drop", async event => {
        const files = Array.from(event.dataTransfer.files || []);
        if (!files.length) {
          const droppedPath = pathFromDropText(
            event.dataTransfer.getData("text/uri-list") ||
            event.dataTransfer.getData("text/plain") ||
            ""
          );
          if (droppedPath) {
            document.querySelector("#convertPath").value = droppedPath;
            setConvertStatus("File selected. Choose action, then press Start Convert.");
            return;
          }
          setConvertStatus("No file was received. Try dropping from Windows Explorer.");
          return;
        }

        await browseConvertFile("Windows hides paths from this drop. Pick the same file once.");
      });
    }

    setupCutFileDrop();
    setupConvertFileDrop();

    function renderPending() {
      if (!initialTargets.length) return;
      pendingSection.hidden = false;
      pendingEl.innerHTML = "";
      initialTargets.forEach(target => {
        const item = document.createElement("div");
        item.className = "pending-item";
        const isUrl = /^https?:\\/\\//i.test(target);
        item.innerHTML = \`
          <div>
            <div class="path" title="\${target.replaceAll('"', "&quot;")}">\${target}</div>
          </div>
          <label>Action
            <select>
              \${isUrl
                ? '<option value="mp4">MP4 video</option><option value="mkv">MKV video</option><option value="mp3">MP3 audio</option><option value="native">Native source</option>'
                : '<option value="audio">Extract MP3</option><option value="mp4">Re-mux MP4</option><option value="mkv">Re-mux MKV</option><option value="cut">Cut segment</option>'}
            </select>
          </label>
          <button>Start</button>
        \`;
        item.querySelector("button").addEventListener("click", async () => {
          const action = item.querySelector("select").value;
          await postJson("/api/jobs", { kind: isUrl ? "web" : "path", target, action });
          item.remove();
          if (!pendingEl.children.length) pendingSection.hidden = true;
          await refreshJobs();
        });
        pendingEl.append(item);
      });
    }

    function renderJobs(jobs) {
      jobsEl.innerHTML = "";
      if (!jobs.length) {
        jobsEl.innerHTML = "<div class='status'>No jobs yet.</div>";
        return;
      }

      for (const job of jobs) {
        const el = document.createElement("div");
        el.className = "job";
        const hasProgress = typeof job.progress === "number";
        const progress = hasProgress ? Math.max(0, Math.min(100, job.progress)) : 0;
        const indeterminate = job.status === "running" && !hasProgress;
        const latest = job.latestLine || (indeterminate ? "Working..." : "Waiting...");
        el.innerHTML = \`
          <div class="job-head">
            <div class="path" title="\${job.title.replaceAll('"', "&quot;")}">\${job.title}</div>
            <div class="badge \${job.status}">\${job.status}</div>
          </div>
          <div class="job-progress">
            <div class="progress-track"><div class="progress-fill \${indeterminate ? "indeterminate" : ""}" style="\${indeterminate ? "" : "width:" + progress + "%"}"></div></div>
            <div class="latest-line" title="\${latest.replaceAll('"', "&quot;")}">\${latest}</div>
          </div>
          <button class="log-toggle" data-job-id="\${job.id}">\${openLogs.has(job.id) ? "Hide Logs" : "Show Logs"}</button>
          <pre \${openLogs.has(job.id) ? "" : "hidden"}>\${job.logs.join("\\n")}</pre>
        \`;
        jobsEl.append(el);
        const toggle = el.querySelector(".log-toggle");
        toggle.addEventListener("click", () => {
          if (openLogs.has(job.id)) {
            openLogs.delete(job.id);
          } else {
            openLogs.add(job.id);
          }
          lastJobsPayload = "";
          refreshJobs();
        });
        const log = el.querySelector("pre");
        if (job.status === "running" && openLogs.has(job.id)) {
          log.scrollTop = log.scrollHeight;
        }
      }
    }

    async function refreshJobs() {
      const response = await fetch("/api/jobs");
      const payload = await response.text();
      if (payload === lastJobsPayload) return;
      lastJobsPayload = payload;
      const data = JSON.parse(payload);
      renderJobs(data.jobs);
    }

    function heartbeat() {
      fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }

    renderPending();
    loadSettings().then(() => checkSvidUpdate(true)).catch(() => {});
    heartbeat();
    refreshJobs();
    setInterval(heartbeat, 1500);
    setInterval(refreshJobs, 1000);
  </script>
</body>
</html>`;
}

async function handleUiRequest(
  request: Request,
  initialTargets: string[],
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(webUi(initialTargets), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/jobs") {
    const allJobs = [...jobs.values()].sort((a, b) =>
      b.createdAt - a.createdAt
    );
    return json({ jobs: allJobs });
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    return json(await loadSettings());
  }

  if (request.method === "POST" && url.pathname === "/api/settings") {
    const body = await request.json();
    const settings = await loadSettings();

    for (const tool of ["svid", "yt-dlp", "ffmpeg", "deno"] as const) {
      const interval = body.updateIntervals?.[tool];
      if (isUpdateInterval(interval)) {
        settings.updateIntervals[tool] = interval;
      }
    }

    for (
      const key of ["downloads", "cuts", "converts", "subtitles"] as const
    ) {
      const value = body.outputDirs?.[key];
      if (typeof value === "string" && value.trim()) {
        settings.outputDirs[key] = resolve(value.trim());
      }
    }

    await saveSettings(settings);
    return json(settings);
  }

  if (request.method === "POST" && url.pathname === "/api/svid-update/check") {
    const body = await request.json().catch(() => ({}));
    try {
      return json(await checkSvidUpdate(Boolean(body.scheduled)));
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  }

  if (
    request.method === "POST" && url.pathname === "/api/svid-update/install"
  ) {
    try {
      return json(await installLatestSvidUpdate());
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/open-folder") {
    const body = await request.json();
    const settings = await loadSettings();
    const key = String(body.key ?? "");
    if (
      key !== "downloads" && key !== "cuts" && key !== "converts" &&
      key !== "subtitles"
    ) {
      return json({ error: "Invalid folder key." }, 400);
    }

    const folder = settings.outputDirs[key];
    await Deno.mkdir(folder, { recursive: true });

    if (isWindows) {
      await new Deno.Command("powershell", {
        args: ["-NoProfile", "-Command", "Start-Process $env:TARGET_FOLDER"],
        env: { TARGET_FOLDER: folder },
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn().status;
    }

    return json({ ok: true, path: folder });
  }

  if (request.method === "POST" && url.pathname === "/api/browse-file") {
    const body = await request.json().catch(() => ({}));
    const kind = String(body.kind ?? "media");
    const path = kind === "text"
      ? await browseWindowsTextFile()
      : await browseWindowsVideoFile();
    return json({ path });
  }

  if (request.method === "POST" && url.pathname === "/api/heartbeat") {
    lastUiHeartbeat = Date.now();
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await request.json();
    const target = cleanInput(String(body.target ?? ""));
    const action = String(body.action ?? "");

    if (body.kind !== "subtitle" && !target) {
      return json({ error: "Missing target." }, 400);
    }

    if (body.kind === "subtitle") {
      const mediaPath = cleanInput(String(body.mediaPath ?? ""));
      const scriptPath = cleanInput(String(body.scriptPath ?? ""));
      const language = cleanLanguageCode(body.language);
      const model = cleanSubtitleModel(body.model);
      const wordsPerCue = cleanSubtitleWordsPerCue(body.wordsPerCue);
      const outputMode = cleanSubtitleOutputMode(body.outputMode);
      const assStyle: AssStyleOptions = {
        fontSize: cleanAssFontSize(body.assFontSize),
        activeColor: cleanHexColor(
          body.assActiveColor,
          defaultAssStyle.activeColor,
        ),
        passedColor: cleanHexColor(
          body.assPassedColor,
          defaultAssStyle.passedColor,
        ),
      };
      if (!mediaPath || !scriptPath) {
        return json({ error: "Missing media or text file." }, 400);
      }
      if (!(await exists(mediaPath))) {
        return json({ error: `Media file not found: ${mediaPath}` }, 400);
      }
      if (!(await exists(scriptPath))) {
        return json({ error: `Text file not found: ${scriptPath}` }, 400);
      }

      const job = createJob(`Subtitles: ${basename(mediaPath)}`);
      const runner: Runner = (command, args) =>
        runLogged(command, args, (line) => appendLog(job, line), {
          env: {
            UV_CACHE_DIR: join(appDir, "uv-cache"),
            UV_TOOL_DIR: join(appDir, "uv-tools"),
            UV_PYTHON_INSTALL_DIR: join(appDir, "uv-python"),
            UV_LINK_MODE: "copy",
          },
        });
      const settings = await loadSettings();

      startJob(job, async (log) => {
        log("Checking ffmpeg...");
        if (!(await ensureTool("ffmpeg"))) {
          log("ffmpeg could not be installed.");
          return 1;
        }

        log("Checking subtitle tools...");
        if (!(await ensureUv(log))) return 1;

        return await processSubtitleAlignment(
          mediaPath,
          scriptPath,
          language,
          model,
          settings.outputDirs.subtitles,
          {
            runner,
            log: (line) => appendLog(job, line),
            wordsPerCue,
            outputMode,
            assStyle,
          },
        );
      });

      return json({ jobId: job.id });
    }

    const job = createJob(target);
    const runner: Runner = (command, args) =>
      runLogged(command, args, (line) => appendLog(job, line));
    const settings = await loadSettings();

    if (body.kind === "web") {
      startJob(job, async (log) => {
        log("Waiting for tools...");
        if (!(await ensureToolsReady(log))) return 1;
        return await processWebDownload(target, action as WebAction, {
          runner,
          outputDir: settings.outputDirs.downloads,
          log: (line) => appendLog(job, line),
        });
      });
      return json({ jobId: job.id });
    }

    startJob(job, async (log) => {
      log("Waiting for tools...");
      if (!(await ensureToolsReady(log))) return 1;
      return await processLocalFile(target, action as LocalAction, {
        runner,
        outputDir: action === "cut"
          ? settings.outputDirs.cuts
          : settings.outputDirs.converts,
        start: String(body.start ?? ""),
        end: String(body.end ?? ""),
        quality: String(body.quality ?? "copy"),
        log: (line) => appendLog(job, line),
      });
    });
    return json({ jobId: job.id });
  }

  if (request.method === "POST" && url.pathname === "/api/upload") {
    const form = await request.formData();
    const file = form.get("file");
    const action = String(form.get("action") ?? "audio") as LocalAction;

    if (!(file instanceof File)) return json({ error: "Missing file." }, 400);

    const saved = await saveUploadedFile(file);
    const job = createJob(file.name);
    const runner: Runner = (command, args) =>
      runLogged(command, args, (line) => appendLog(job, line));
    const settings = await loadSettings();

    startJob(job, async (log) => {
      log("Waiting for tools...");
      if (!(await ensureToolsReady(log))) return 1;
      return await processLocalFile(saved, action, {
        runner,
        outputDir: action === "cut"
          ? settings.outputDirs.cuts
          : settings.outputDirs.converts,
        start: String(form.get("start") ?? ""),
        end: String(form.get("end") ?? ""),
        quality: String(form.get("quality") ?? "copy"),
        log: (line) => appendLog(job, line),
      });
    });

    return json({ jobId: job.id });
  }

  if (request.method === "POST" && url.pathname === "/api/select-file") {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) return json({ error: "Missing file." }, 400);

    const saved = await saveUploadedFile(file);
    return json({ path: saved, name: file.name });
  }

  return new Response("Not found", { status: 404 });
}

async function openAppWindow(url: string) {
  if (isWindows) {
    await new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        "try { Start-Process msedge -ArgumentList @('--app=' + $env:TOOLKIT_URL, '--window-size=960,680', '--window-position=120,80') } catch { Start-Process $env:TOOLKIT_URL }",
      ],
      env: { TOOLKIT_URL: url },
      stdout: "null",
      stderr: "null",
    }).spawn().status;
    return;
  }

  const opener = Deno.build.os === "darwin" ? "open" : "xdg-open";
  await new Deno.Command(opener, {
    args: [url],
    stdout: "null",
    stderr: "null",
  }).spawn().status;
}

async function startUi(
  initialTargets: string[],
  options: { openBrowserWindow?: boolean; port?: number } = {},
) {
  lastUiHeartbeat = Date.now();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    onListen: () => {},
  }, (request) => handleUiRequest(request, initialTargets));

  const url = `http://127.0.0.1:${server.addr.port}`;
  console.log(`${APP_NAME} UI`);
  console.log(url);
  if (options.openBrowserWindow !== false) await openAppWindow(url);

  const shutdownTimer = setInterval(() => {
    const stale = Date.now() - lastUiHeartbeat > 8000;
    if (stale && !hasActiveJobs()) {
      clearInterval(shutdownTimer);
      server.shutdown().catch(() => {});
    }
  }, 2000);

  try {
    await server.finished;
  } finally {
    clearInterval(shutdownTimer);
  }
}

async function processItem(rawTarget: string): Promise<void> {
  const target = cleanInput(rawTarget);
  const local = await isFile(target);

  console.log();
  console.log("--------------------------------------------------");
  console.log(`Target: ${target}`);
  console.log("--------------------------------------------------");

  let code = 1;

  if (local) {
    console.log("[Local File Mode]");
    console.log("  1. Extract Audio to MP3 (default)");
    console.log("  2. Re-mux to MP4");
    console.log("  3. Re-mux to MKV");
    console.log("  4. Cut video segment (accurate)");

    const choice = selectChoice(4);
    if (choice === null) {
      console.log("Invalid choice. Skipping this item.");
      return;
    }

    const action: LocalAction[] = ["audio", "mp4", "mkv", "cut"];
    code = await processLocalFile(target, action[choice - 1]);
  } else {
    console.log("[Web Download Mode]");
    console.log("  1. Download Video as MP4 (default)");
    console.log("  2. Download Video as MKV");
    console.log("  3. Download Audio as MP3");
    console.log("  4. Download Source Video (Native Format)");

    const choice = selectChoice(4);
    if (choice === null) {
      console.log("Invalid choice. Skipping this item.");
      return;
    }

    const action: WebAction[] = ["mp4", "mkv", "mp3", "native"];
    code = await processWebDownload(target, action[choice - 1]);
  }

  console.log();
  if (code === 0) {
    console.log("[DONE] Task complete.");
  } else {
    console.log("[FAILED] Something went wrong while processing this item.");
    console.log(
      "         (For re-mux: the source codecs may not fit the target container.)",
    );
  }
}

async function askMoreLoop() {
  while (true) {
    const input = prompt("Enter URL or local file path: ");
    if (!input?.trim()) continue;
    await processItem(input);

    const more = prompt("Do you want to process another item? (y/n): ");
    if (!more || more.toLowerCase() !== "y") break;
  }
}

async function main() {
  Deno.chdir(appDir);

  if (Deno.args.includes("--version")) {
    console.log(`${APP_NAME} v${APP_VERSION}`);
    return;
  }

  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(`${APP_NAME} v${APP_VERSION}`);
    console.log();
    console.log("Usage:");
    console.log("  Svid.exe");
    console.log("  Svid.exe <url-or-local-file> [more-items...]");
    console.log("  Svid.exe --console");
    console.log("  Svid.exe --no-open --port=8787");
    console.log("  Svid.exe --version");
    return;
  }

  const consoleMode = Deno.args.includes("--console");
  const targets = Deno.args.filter((arg) => !arg.startsWith("--"));
  const requestedPort = Deno.args.find((arg) => arg.startsWith("--port="))
    ?.slice("--port=".length);
  const uiPort = requestedPort ? Number.parseInt(requestedPort, 10) : undefined;

  if (!consoleMode) {
    await startUi(targets, {
      openBrowserWindow: !Deno.args.includes("--no-open"),
      port: Number.isInteger(uiPort) ? uiPort : undefined,
    });
    return;
  }

  header();

  if (!(await ensureToolsReady())) {
    console.log();
    console.log("A required tool could not be installed. Aborting.");
    prompt("Press Enter to exit...");
    Deno.exit(1);
  }

  if (targets.length > 0) {
    for (const arg of targets) {
      await processItem(arg);
    }

    const more = prompt("Do you want to process another item? (y/n): ");
    if (more?.toLowerCase() === "y") await askMoreLoop();
  } else {
    await askMoreLoop();
  }

  console.log("Bye.");
  prompt("Press Enter to exit...");
}

if (import.meta.main) {
  await main();
}
