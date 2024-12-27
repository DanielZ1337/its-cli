import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "esnext",
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  external: ["puppeteer"],
  outDir: "dist",
});
