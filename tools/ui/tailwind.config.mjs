import { fileURLToPath } from "node:url";

const staticDir = fileURLToPath(new URL("../../apps/cairn/src/http/static/", import.meta.url));

// Shared utility theme; workspace layout and design tokens live in input.css.
// Keep both font families (a top-level fontFamily replaces the entire scale).
// 2xs remains the 11px utility floor; workspace/dialog body text is raised to 12px.
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
          50: "#f0fdfa", 100: "#ccfbf1", 200: "#99f6e4", 300: "#5eead4", 400: "#2dd4bf",
          500: "#0d9488", 600: "#0f766e", 700: "#115e59", 800: "#134e4a", 900: "#123f3c",
        },
      },
    },
  },
  corePlugins: { preflight: true },
};
