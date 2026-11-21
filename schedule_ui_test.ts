import { equal, ok } from "node:assert/strict";
import { parse } from "npm:parse5@8.0.0";
import type { DefaultTreeAdapterMap } from "npm:parse5@8.0.0";
import { webUi } from "./downloader.ts";

Deno.test("Windows and Mac UI include separate dates and a local time picker with valid scripts", () => {
  for (const platform of ["windows", "darwin"] as const) {
    const ids = new Map<string, number>();
    const scripts: string[] = [];
    function walk(node: DefaultTreeAdapterMap["node"]) {
      if ("attrs" in node) {
        const id = node.attrs.find((attr) => attr.name === "id")?.value;
        if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
        if (node.tagName === "script") {
          scripts.push(node.childNodes.map((child) => "value" in child ? child.value : "").join(""));
        }
        ok(!node.attrs.some((attr) => attr.name === "type" && attr.value === "datetime-local"));
      }
      if ("childNodes" in node) node.childNodes.forEach(walk);
    }
    walk(parse(webUi([], platform)));
    for (const id of ["liveStartDate", "liveStartTime", "liveEndDate", "liveEndTime",
      "liveTimePicker", "timePickerHours", "timePickerMinutes", "timePickerCancel", "timePickerClear"]) {
      equal(ids.get(id), 1, `${platform}: missing or duplicate ${id}`);
    }
    ok(scripts.length > 0);
    for (const script of scripts) new Function(script);
  }
});
