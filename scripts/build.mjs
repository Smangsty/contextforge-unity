import { build } from "esbuild";

await build({
  entryPoints: ["src/contextforge-unity.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "bin/contextforge-unity.mjs",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  treeShaking: true
});
