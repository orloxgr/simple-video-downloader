import { equal, throws } from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileTimestamp, resolveJobOutputDir } from "./downloader.ts";

Deno.test("same as input overrides the custom and default destinations", () => {
  for (const input of [
    "C:\\Videos\\clip.mp4",
    "\\\\filesrv\\Design\\video folder\\clip.mp4",
  ]) {
    equal(
      resolveJobOutputDir(
        { sameAsInput: true, outputDir: "D:\\Other" },
        "D:\\Default",
        input,
      ),
      dirname(resolve(input)),
    );
  }
  throws(() => resolveJobOutputDir({ sameAsInput: true }, "D:\\Default"));
});

Deno.test("per-job destinations do not change the saved default", () => {
  const fallback = "C:\\Videos\\Svid\\cuts";
  equal(
    resolveJobOutputDir({ outputDir: '"D:\\My clips"' }, fallback),
    resolve("D:\\My clips"),
  );
  equal(resolveJobOutputDir({}, fallback), resolve(fallback));
  equal(resolveJobOutputDir({ outputDir: " " }, fallback), resolve(fallback));
});

Deno.test("output timestamps include milliseconds and are filename safe", () => {
  const first = new Date(2026, 9, 31, 8, 5, 9, 1);
  const second = new Date(2026, 9, 31, 8, 5, 9, 2);
  equal(fileTimestamp(first), "20261031-080509-001");
  equal(fileTimestamp(second), "20261031-080509-002");
});
