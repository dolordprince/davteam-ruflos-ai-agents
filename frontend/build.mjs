import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js"]) {
  await copyFile(
    resolve(root, "src", file),
    resolve(dist, file)
  );
}

console.log("Osiri frontend build complete");
console.log("dist/index.html");
console.log("dist/styles.css");
console.log("dist/app.js");
