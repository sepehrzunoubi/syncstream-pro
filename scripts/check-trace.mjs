// After `next build`: the files a deployment ships with each route are the ones the build traced.
// Files a library loads by a path worked out at run time aren't traced unless the code names them,
// and a deployment without them fails where a local run (all of node_modules there) works. This
// checks the routes that read PDFs ship pdf.js's worker, and Import PDF its fonts and character maps.
import fs from "node:fs";
import path from "node:path";

const NEEDS = {
  "app/api/pdf/import/route.js": ["pdfjs-dist/legacy/build/pdf.worker.mjs", "pdfjs-dist/standard_fonts/", "pdfjs-dist/cmaps/", "@napi-rs/canvas"],
  "app/api/docs/pages/route.js": ["pdfjs-dist/legacy/build/pdf.worker.mjs"],
};

let failed = false;
for (const [route, needs] of Object.entries(NEEDS)) {
  const trace = path.join(".next", "server", `${route}.nft.json`);
  if (!fs.existsSync(trace)) {
    console.error(`${trace} is missing: run next build first`);
    failed = true;
    continue;
  }
  const files = JSON.parse(fs.readFileSync(trace, "utf8")).files.map((f) => f.split(path.sep).join("/"));
  for (const need of needs) {
    if (!files.some((f) => f.includes(`node_modules/${need}`))) {
      console.error(`${route} doesn't ship node_modules/${need}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("Every route ships the files it loads at run time.");
