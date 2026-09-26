const fs = require("fs");
const path = require("path");

const frontend = path.resolve(__dirname, "..", "frontend");
const source = path.join(frontend, "src");
const dist = path.join(frontend, "dist");

const requiredSource = [
  "index.html",
  "styles.css",
  "app.js",
];

const requiredDist = requiredSource;

if (!fs.existsSync(source)) {
  throw new Error("frontend/src is missing");
}

fs.mkdirSync(dist, { recursive: true });

for (const file of requiredSource) {
  const src = path.join(source, file);
  const dst = path.join(dist, file);

  if (!fs.existsSync(src)) {
    throw new Error(`Missing frontend source file: ${src}`);
  }

  fs.copyFileSync(src, dst);
}

for (const file of requiredDist) {
  const dst = path.join(dist, file);

  if (!fs.existsSync(dst)) {
    throw new Error(`Missing frontend build file: ${dst}`);
  }
}

console.log("PASS: frontend build");
console.log("PASS: index.html");
console.log("PASS: styles.css");
console.log("PASS: app.js");
