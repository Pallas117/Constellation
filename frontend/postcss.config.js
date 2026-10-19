import { fileURLToPath } from "node:url";

export default {
  plugins: {
    // One Tailwind config for every entry point (repo root or frontend/).
    tailwindcss: { config: fileURLToPath(new URL("../tailwind.config.cjs", import.meta.url)) },
    autoprefixer: {},
  },
};
