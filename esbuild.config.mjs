import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "src");
const distDir = join(__dirname, "dist");

const entryPoints = [
  join(srcDir, "background", "service-worker.ts"),
  join(srcDir, "content", "index.ts"),
  join(srcDir, "popup", "popup.ts"),
  join(srcDir, "options", "options.ts"),
];

const isWatch = process.argv.includes("--watch");

const config = {
  entryPoints,
  outdir: distDir,
  bundle: true,
  sourcemap: true,
  minify: false,
  format: "esm",
  target: "es2022",
  outbase: srcDir,
  keepNames: true,
};

const ASSET_EXTENSIONS = new Set([".html", ".css", ".json", ".svg", ".png"]);

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (ASSET_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

function copyAssets() {
  copyFileSync(join(srcDir, "manifest.json"), join(distDir, "manifest.json"));
  copyFileSync(join(srcDir, "test-page.html"), join(distDir, "test-page.html"));
  copyDir(join(srcDir, "icons"), join(distDir, "icons"));
  copyDir(join(srcDir, "popup"), join(distDir, "popup"));
  copyDir(join(srcDir, "options"), join(distDir, "options"));
}

async function build() {
  if (isWatch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(config);
    copyAssets();
    console.log("Build complete → dist/");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
