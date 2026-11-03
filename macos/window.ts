import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type Menu = {
  items: {
    id?: string;
    label?: string;
    role?: string;
    accelerator?: string;
    submenu?: Menu;
  }[];
};
type View = {
  evaluateScript(script: string): void;
  expose(name: string, methods: Record<string, () => Promise<void>>): void;
  on(event: string, callback: (event: { paths?: string[] }) => void): void;
  setBackgroundColor(r: number, g: number, b: number, a: number): void;
};
type NativeWindow = {
  createWebview(options: {
    url: string;
    nativeFileDrop: boolean;
    enableDevtools: boolean;
    navigationHandler(url: string): boolean;
    newWindowHandler(event: { url?: string }): boolean;
  }): View;
  on(
    event: string,
    callback: (event: { preventDefault(): void }) => void,
  ): void;
  setTheme(theme: number): void;
  setMinSize(width: number, height: number, logical: boolean): void;
  setMinimized(value: boolean): void;
  setTitle(title: string): void;
  show(): void;
  focus(): void;
  center(): void;
};
type NativeApplication = {
  createBrowserWindow(
    options: { title: string; width: number; height: number; logical: boolean },
  ): NativeWindow;
  setMenu(menu: Menu): void;
  on(
    event: string,
    callback: (event: { customMenuEvent?: { id?: string } }) => void,
  ): void;
  run(): void;
  exit(): void;
};
export type WindowRuntime = {
  Application: new () => NativeApplication;
  Theme: { Dark: number };
};

export function loadMacWindowRuntime(): WindowRuntime {
  // Keep the native addon outside Deno's embedded filesystem so dlopen can load it.
  const require = createRequire(import.meta.url);
  return require(
    join(dirname(Deno.execPath()), "..", "Resources", "webview", "index.js"),
  );
}

export function createMacWindow(
  url: string,
  title: string,
  runtime: WindowRuntime,
  callbacks: {
    shutdown(waitForJobs?: boolean): Promise<void>;
    openExternal(url: string): Promise<void>;
    onError(error: unknown): void;
  },
) {
  const origin = new URL(url).origin;
  const app = new runtime.Application();
  let disposed = false;
  let closing = false;
  let view: View;

  function dispose() {
    if (disposed) return;
    disposed = true;
    app.exit();
  }

  try {
    // A custom Quit item goes through Stop & Save, unlike a native quit role.
    app.setMenu({
      items: [
        {
          label: "Svid",
          submenu: {
            items: [
              { role: "about" },
              { role: "separator" },
              { role: "hide" },
              { role: "hideothers" },
              { role: "showall" },
              { role: "separator" },
              {
                id: "svid-quit",
                label: "Quit Svid",
                accelerator: "CmdOrCtrl+Q",
              },
            ],
          },
        },
        {
          label: "Edit",
          submenu: {
            items: [
              { role: "undo" },
              { role: "redo" },
              { role: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectall" },
            ],
          },
        },
        {
          label: "Window",
          submenu: { items: [{ role: "minimize" }, { role: "fullscreen" }] },
        },
      ],
    });
    const window = app.createBrowserWindow({
      title,
      width: 960,
      height: 680,
      logical: true,
    });
    window.setTheme(runtime.Theme.Dark);
    window.setMinSize(760, 520, true);
    window.center();

    const showError = (error: unknown) => {
      callbacks.onError(error);
      const message = error instanceof Error ? error.message : String(error);
      view.evaluateScript(`alert(${JSON.stringify(message)})`);
    };

    const navigate = (target: string): boolean => {
      try {
        const destination = new URL(target);
        if (destination.origin === origin) return destination.pathname === "/";
        if (["http:", "https:"].includes(destination.protocol)) {
          queueMicrotask(() => {
            void callbacks.openExternal(target).catch(showError);
          });
        }
      } catch { /* Reject non-URL navigation and non-web schemes. */ }
      return false;
    };

    view = window.createWebview({
      url,
      nativeFileDrop: true,
      enableDevtools: false,
      navigationHandler: navigate,
      newWindowHandler: (event) => {
        if (event.url) navigate(event.url);
        return false;
      },
    });
    view.setBackgroundColor(24, 24, 28, 255);

    const close = async () => {
      if (closing || disposed) return;
      closing = true;
      window.setTitle("Svid - Saving recordings...");
      try {
        await callbacks.shutdown();
        dispose();
      } catch (error) {
        closing = false;
        window.setTitle(title);
        showError(error);
      }
    };

    window.on("close", (event) => {
      event.preventDefault();
      void close();
    });
    app.on("custom-menu-click", (event) => {
      if (event.customMenuEvent?.id === "svid-quit") void close();
    });
    app.on("application-close-requested", () => {
      if (disposed) return;
      dispose();
      void callbacks.shutdown(true).catch(callbacks.onError);
    });
    view.expose("svidNative", { quit: close });
    view.on("drag-drop", (event) => {
      const paths = (event.paths ?? []).filter((path) =>
        typeof path === "string"
      );
      if (paths.length) {
        view.evaluateScript(
          `window.handleNativeFileDrop?.(${JSON.stringify(paths)}); void 0;`,
        );
      }
    });
    app.run();

    return {
      focus() {
        if (disposed) return;
        window.setMinimized(false);
        window.show();
        window.focus();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
