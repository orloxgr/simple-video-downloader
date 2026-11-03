import { deepEqual, equal, match } from "node:assert/strict";
import { createMacWindow, type WindowRuntime } from "./window.ts";

type App = InstanceType<WindowRuntime["Application"]>;
type Window = ReturnType<App["createBrowserWindow"]>;
type View = ReturnType<Window["createWebview"]>;

function fixture(shutdown: (wait?: boolean) => Promise<void> = async () => {}) {
  const scripts: string[] = [];
  const external: string[] = [];
  const errors: unknown[] = [];
  const appEvents = new Map<string, Parameters<App["on"]>[1]>();
  const windowEvents = new Map<string, Parameters<Window["on"]>[1]>();
  const viewEvents = new Map<string, Parameters<View["on"]>[1]>();
  const api = new Map<string, Record<string, () => Promise<void>>>();
  let windowOptions: Parameters<App["createBrowserWindow"]>[0];
  let viewOptions: Parameters<Window["createWebview"]>[0];
  let menu: Parameters<App["setMenu"]>[0];
  let exited = 0;
  let focused = 0;
  let title = "";
  const view: View = {
    evaluateScript: (script) => {
      scripts.push(script);
    },
    expose: (name, methods) => {
      api.set(name, methods);
    },
    on: (event, handler) => {
      viewEvents.set(event, handler);
    },
    setBackgroundColor() {},
  };
  const window: Window = {
    createWebview(options) {
      viewOptions = options;
      return view;
    },
    on: (event, handler) => {
      windowEvents.set(event, handler);
    },
    setTheme() {},
    setMinSize() {},
    setMinimized() {},
    show() {},
    center() {},
    focus() {
      focused++;
    },
    setTitle(value) {
      title = value;
    },
  };
  class Application implements App {
    createBrowserWindow(options: typeof windowOptions) {
      windowOptions = options;
      return window;
    }
    setMenu(value: typeof menu) {
      menu = value;
    }
    on(event: string, handler: Parameters<App["on"]>[1]) {
      appEvents.set(event, handler);
    }
    run() {}
    exit() {
      exited++;
    }
  }
  const controller = createMacWindow("http://127.0.0.1:12345", "Svid - title", {
    Application,
    Theme: { Dark: 1 },
  }, {
    shutdown,
    openExternal: (url) => {
      external.push(url);
      return Promise.resolve();
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    controller,
    scripts,
    external,
    errors,
    appEvents,
    windowEvents,
    viewEvents,
    api,
    get windowOptions() {
      return windowOptions;
    },
    get viewOptions() {
      return viewOptions;
    },
    get menu() {
      return menu;
    },
    get exited() {
      return exited;
    },
    get focused() {
      return focused;
    },
    get title() {
      return title;
    },
  };
}

Deno.test("Mac window keeps the UI embedded and opens only web links externally", async () => {
  const f = fixture();
  deepEqual(f.windowOptions, {
    title: "Svid - title",
    width: 960,
    height: 680,
    logical: true,
  });
  equal(f.viewOptions.nativeFileDrop, true);
  equal(f.viewOptions.enableDevtools, false);
  equal(f.viewOptions.navigationHandler("http://127.0.0.1:12345/#cut"), true);
  for (
    const url of [
      "http://127.0.0.1:12345/api/jobs",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]
  ) {
    equal(f.viewOptions.navigationHandler(url), false);
  }
  equal(
    f.viewOptions.navigationHandler(
      "https://github.com/orloxgr/simple-video-downloader",
    ),
    false,
  );
  await Promise.resolve();
  deepEqual(f.external, ["https://github.com/orloxgr/simple-video-downloader"]);
  f.controller.focus();
  equal(f.focused, 1);
  f.controller.dispose();
  f.controller.dispose();
  equal(f.exited, 1);
});

Deno.test("Mac file drops pass original Unicode paths without uploading or starting a job", () => {
  const f = fixture();
  const paths = [
    "/Users/byron/Videos/\u03b2\u03af\u03bd\u03c4\u03b5\u03bf [1] 'clip'.mp4",
    "/Volumes/Design/a b.txt",
  ];
  f.viewEvents.get("drag-drop")!({ paths });
  equal(
    f.scripts[0],
    `window.handleNativeFileDrop?.(${JSON.stringify(paths)}); void 0;`,
  );
  f.controller.dispose();
});

Deno.test("Mac close and Quit wait for saving and do not run shutdown twice", async () => {
  let finish!: () => void;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  let prevented = false;
  f.windowEvents.get("close")!({
    preventDefault() {
      prevented = true;
    },
  });
  f.appEvents.get("custom-menu-click")!({
    customMenuEvent: { id: "svid-quit" },
  });
  equal(prevented, true);
  equal(calls, 1);
  equal(f.exited, 0);
  finish();
  await Promise.resolve();
  equal(f.exited, 1);
  equal(f.menu.items[0].submenu!.items.at(-1)!.id, "svid-quit");
});

Deno.test("Mac refuses a busy close, reports it, and permits retry from Settings", async () => {
  let attempts = 0;
  const f = fixture(() => {
    if (++attempts === 1) {
      return Promise.reject(new Error('Wait for "current job"'));
    }
    return Promise.resolve();
  });
  await f.api.get("svidNative")!.quit();
  equal(f.exited, 0);
  equal(f.title, "Svid - title");
  equal(f.errors.length, 1);
  match(f.scripts[0], /alert\("Wait for \\"current job\\""\)/);
  await f.api.get("svidNative")!.quit();
  equal(f.exited, 1);
});

Deno.test("unexpected native closure still saves recordings and waits for active jobs", async () => {
  let waitForJobs: boolean | undefined;
  const f = fixture((wait) => {
    waitForJobs = wait;
    return Promise.resolve();
  });
  f.appEvents.get("application-close-requested")!({});
  await Promise.resolve();
  equal(waitForJobs, true);
  equal(f.exited, 1);
});
