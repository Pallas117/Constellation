import path from "node:path";
import { fileURLToPath } from "node:url";

// One Tailwind config (the brand tokens) at the repo root, whichever directory Vite runs from.
const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(here, "..", "tailwind.config.cjs") },
    autoprefixer: {},
  },
};
