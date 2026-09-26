import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const frontend = join(root, "frontend");
const source = join(frontend, "src");
const dist = join(frontend, "dist");

const files = [
  "index.html",
  "styles.css",
  "app.js",
];

if (!existsSync(frontend)) {
  throw new Error("frontend directory is missing");
}

if (!existsSync(source)) {
  throw new Error("frontend/src directory is missing");
}

mkdirSync(dist, { recursive: true });

for (const file of files) {
  const src = join(source, file);
  const dst = join(dist, file);

  if (!existsSync(src)) {
    throw new Error(`Missing frontend source file: ${src}`);
  }

  copyFileSync(src, dst);
}

for (const file of files) {
  const dst = join(dist, file);

  if (!existsSync(dst)) {
    throw new Error(`Frontend build failed: ${dst}`);
  }
}

console.log("PASS: Osiri frontend build");
console.log("PASS: frontend/dist/index.html");
console.log("PASS: frontend/dist/styles.css");
console.log("PASS: frontend/dist/app.js");
