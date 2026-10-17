// ColaMD: drop the 37 px window-decoration strip on Wayland.
//
// ColaMD creates its window with
//     titleBarStyle: isWindows ? "hidden" : "hiddenInset"
// macOS supports "hiddenInset"; Linux does not, so Chromium falls back to a real
// decoration — the "ColaMD  ✕" row. Measured on niri/Wayland (BrowserWindow
// bounds minus content bounds, with the menu bar already hidden by
// colamd-main-inject.mjs): 37 px. With titleBarStyle "hidden": 0 px.
//
// The app's own chrome (#titlebar, 36 px, `-webkit-app-region: drag`) lives
// inside the page and is untouched, so the window still drags when floating, and
// ColaMD still has its own menu button. Closing goes through the compositor
// (niri: Mod+Q) — the decoration's ✕ is the only thing that disappears.
//
// Why an interception rather than a patch of the created window: the electron
// module's `BrowserWindow` is a non-configurable accessor
// (`{configurable:false, get:fn}`, verified) — neither `defineProperty` nor plain
// assignment can replace it, and a window's titleBarStyle cannot be changed after
// creation. So the constructor is wrapped while the app bundle is loading.
//
// Loaded via NODE_OPTIONS=--require from the launcher wrapper. Remove it there to
// revert; no file inside ColaMD is ever modified.
const Module = require("module");

// Renderers, GPU and utility processes also run this; only the main process
// creates BrowserWindows.
if (process.type === "browser" && !globalThis.__colamdFramePatch) {
  globalThis.__colamdFramePatch = true;
  const originalLoad = Module._load;
  let announced = false;

  Module._load = function (request, parent, isMain) {
    const mod = originalLoad.apply(this, arguments);
    if (request !== "electron" || !mod || typeof mod !== "object") return mod;

    const BrowserWindow = mod.BrowserWindow;
    if (!BrowserWindow) return mod;

    const Patched = new Proxy(BrowserWindow, {
      construct(target, args, newTarget) {
        const options = args[0];
        if (options && typeof options === "object" && !Array.isArray(options)) {
          // "hiddenInset" is the value ColaMD passes on every non-Windows platform.
          // Nothing is invented for other values: only the unsupported one is fixed.
          if (options.titleBarStyle === "hiddenInset") {
            options.titleBarStyle = "hidden";
            if (!announced) {
              announced = true;
              console.log("colamd-frame-patch: titleBarStyle hiddenInset -> hidden");
            }
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
    });

    // The module object itself is extensible, so the accessor is shadowed here and
    // every consumer (`require("electron").BrowserWindow`) sees the wrapper.
    return new Proxy(mod, {
      get(target, prop, receiver) {
        return prop === "BrowserWindow" ? Patched : Reflect.get(target, prop, receiver);
      },
    });
  };
}
