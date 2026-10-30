import { fileURLToPath } from "node:url";

const staticDir = fileURLToPath(new URL("../../apps/cairn/src/http/static/", import.meta.url));

// Mirrors the theme that the old Play-CDN runtime carried inline in index.html,
// with two deliberate fixes: `mono` is back (a top-level `fontFamily` replaces the
// whole scale, so the CDN silently produced no `.font-mono` rule for 94 call sites)
// and `2xs` is the legibility floor for Chinese UI text (11px).
export default {
  content: [`${staticDir}index.html`],
  theme: {
    fontFamily: {
      sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "Segoe UI", "sans-serif"],
      mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "monospace"],
    },
    extend: {
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1.3" }],
      },
      colors: {
        brand: {
          50: "#eef2ff", 100: "#e0e7ff", 200: "#c7d2fe", 300: "#a5b4fc", 400: "#818cf8",
          500: "#6366f1", 600: "#4f46e5", 700: "#4338ca", 800: "#3730a3", 900: "#312e81",
        },
      },
    },
  },
  corePlugins: { preflight: true },
};
