import { deepEqual, equal, match } from "node:assert/strict";
import {
  alphaPlayerSource,
  DOWNLOAD_OUTPUT_TEMPLATE,
  resolveDownloadSource,
} from "./web_download.ts";

const page = "https://www.alphatv.gr/politika/example/";

Deno.test("download names bound Unicode title and ID bytes and retain the extension", () => {
  equal(DOWNLOAD_OUTPUT_TEMPLATE, "%(title).100B [%(id).40B].%(ext)s");
});

Deno.test("Alpha reads the player source, decodes HTML attributes and ignores ad links", () => {
  const html = `
    <iframe src="https://ads.example/advert.mp4"></iframe>
    <div data-video-url="https://ads.example/not-a-player.mp4"></div>
    <div data-video-url='https://alphavod.siliconweb.com/news.mp4?a=1&amp;b=2'
         CLASS='embed_video kwik-player' data-video-title='A &quot;title&quot;'></div>
    <div class="kwik-player" data-video-url="https://alphavod.siliconweb.com/other.mp4"></div>`;
  deepEqual(alphaPlayerSource(html, page), {
    url: "https://alphavod.siliconweb.com/news.mp4?a=1&b=2",
    referer: page,
  });
});

Deno.test("Alpha handles relative media URLs and rejects invalid protocols and embedded credentials", () => {
  deepEqual(
    alphaPlayerSource(
      '<div class="kwik-player" data-video-url="/media/clip.mp4"></div>',
      page,
    ),
    {
      url: "https://www.alphatv.gr/media/clip.mp4",
      referer: page,
    },
  );
  for (
    const source of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:password@example.com/video.mp4",
    ]
  ) {
    equal(
      alphaPlayerSource(
        `<div class="kwik-player" data-video-url="${source}"></div>`,
        page,
      ),
      undefined,
    );
  }
  equal(
    alphaPlayerSource(
      '<div class="kwik-player" data-video-url="https://example.com/video.mp4"></div>',
      "https://alphatv.gr.example.com/",
    ),
    undefined,
  );
});

Deno.test("the Alpha resolver fetches HTML only and passes the page as Referer", async () => {
  const requests: string[] = [];
  const result = await resolveDownloadSource(page, {
    fetchPage: (input, init) => {
      requests.push(String(input));
      equal(init?.signal instanceof AbortSignal, true);
      match(new Headers(init?.headers).get("user-agent")!, /Mozilla/);
      return Promise.resolve(
        new Response(
          '<div class="kwik-player" data-video-url="https://alphavod.siliconweb.com/video.mp4"></div>',
        ),
      );
    },
  });
  deepEqual(requests, [page]);
  deepEqual(result, {
    url: "https://alphavod.siliconweb.com/video.mp4",
    referer: page,
  });
});

Deno.test("Facebook, other sites, lookalike domains and direct media URLs are unchanged without fetching", async () => {
  for (
    const target of [
      "https://www.facebook.com/watch/?v=1461280656062624",
      "https://www.youtube.com/watch?v=example",
      "https://alphatv.gr.example.com/news/",
      "https://alphavod.alphatv.gr/video.mp4",
      "https://www.alphatv.gr/video.mp4",
      "not-a-url",
    ]
  ) {
    deepEqual(
      await resolveDownloadSource(target, {
        fetchPage: () => {
          throw new Error("Should not fetch this target");
        },
      }),
      { url: target },
    );
  }
});

Deno.test("missing Alpha sources and HTTP/network failures retain the original yt-dlp path", async () => {
  for (
    const fetchPage of [
      () => Promise.resolve(new Response("<html>No video here</html>")),
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
      () => Promise.reject(new Error("offline")),
    ]
  ) {
    const logs: string[] = [];
    deepEqual(
      await resolveDownloadSource(page, {
        fetchPage,
        log: (line) => logs.push(line),
      }),
      { url: page },
    );
    match(logs.at(-1)!, /Trying the page with yt-dlp/);
  }
});
