import { type DefaultTreeAdapterMap, parse } from "npm:parse5@8.0.0";

// Leave room for separate format IDs, fragment/part suffixes and Unicode normalization.
export const DOWNLOAD_OUTPUT_TEMPLATE = "%(title).100B [%(id).40B].%(ext)s";

export const ALPHA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

type DownloadSource = { url: string; referer?: string };

function isAlphaPage(url: URL): boolean {
  return ["http:", "https:"].includes(url.protocol) &&
    ["alphatv.gr", "www.alphatv.gr"].includes(url.hostname) &&
    !/\.(?:mp4|m3u8|mpd)$/i.test(url.pathname);
}

export function alphaPlayerSource(
  html: string,
  pageUrl: string,
): DownloadSource | undefined {
  const page = new URL(pageUrl);
  if (!isAlphaPage(page)) return;
  const pending: DefaultTreeAdapterMap["node"][] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ("attrs" in node) {
      const classes = node.attrs.find((attr) =>
        attr.name === "class"
      )?.value.split(/\s+/) ?? [];
      const source = node.attrs.find((attr) => attr.name === "data-video-url")
        ?.value.trim();
      if (source && classes.includes("kwik-player")) {
        try {
          const media = new URL(source, page);
          if (
            ["http:", "https:"].includes(media.protocol) && !media.username &&
            !media.password
          ) {
            return { url: media.href, referer: page.href };
          }
        } catch {
          /* Ignore malformed sources and continue looking for a player. */
        }
      }
    }
    if ("childNodes" in node) pending.push(...node.childNodes.toReversed());
  }
}

export async function resolveDownloadSource(
  target: string,
  options: { fetchPage?: typeof fetch; log?: (line: string) => void } = {},
): Promise<DownloadSource> {
  const original = { url: target };
  let page: URL;
  try {
    page = new URL(target);
  } catch {
    return original;
  }
  if (!isAlphaPage(page)) return original;

  const log = options.log ?? (() => {});
  log("Checking the Alpha video player...");
  try {
    const response = await (options.fetchPage ?? fetch)(page.href, {
      headers: { "User-Agent": ALPHA_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const source = alphaPlayerSource(
      await response.text(),
      response.url || page.href,
    );
    if (source) {
      log("Found the video's media URL in the Alpha player.");
      return source;
    }
    log(
      "No public video source was found in the Alpha player. Trying the page with yt-dlp.",
    );
  } catch (error) {
    log(
      `Could not read the Alpha player: ${
        error instanceof Error ? error.message : String(error)
      }. Trying the page with yt-dlp.`,
    );
  }
  return original;
}
