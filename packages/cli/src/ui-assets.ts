// The dashboard bundle, embedded so `bun build --compile` carries it. `bun run build:ui` writes
// packages/ui/dist first; main.ts imports this module lazily so a missing bundle only means no UI.
import appCss from "../../ui/dist/app.css" with { type: "file" };
import appJs from "../../ui/dist/app.js" with { type: "file" };
// Bun types `*.html` imports as a bundle object; with `type: "file"` it is the file path.
import indexHtml from "../../ui/dist/index.html" with { type: "file" };
import type { UiAssets } from "./ui-server.ts";

export const uiAssets: UiAssets = {
  "/": { body: Bun.file(indexHtml as unknown as string), type: "text/html; charset=utf-8" },
  "/assets/app.js": { body: Bun.file(appJs), type: "text/javascript; charset=utf-8" },
  "/assets/app.css": { body: Bun.file(appCss), type: "text/css; charset=utf-8" },
};
