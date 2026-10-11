// Renders a Markdown file to PDF with headless Microsoft Edge
// or Chrome, so the deliverables in docs/ and tests/ can be written as diffable Markdown.
//
//   node scripts/md-to-pdf.mjs <input.md> [output.pdf]
//
// The browser is found in the usual install folders; set PDF_BROWSER to override.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

const BROWSERS = [
  process.env.PDF_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

// Plain, printable, A4. Tables get borders; code is monospace; nothing depends on the app theme.
const STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Segoe UI", system-ui, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #0f172a; }
  h1 { font-size: 20pt; color: #0f2747; border-bottom: 2px solid #1767b0; padding-bottom: 4px; }
  h2 { font-size: 14pt; color: #0f2747; margin-top: 1.4em; break-after: avoid; }
  h3 { font-size: 11.5pt; color: #0f2747; margin-top: 1.1em; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 9.5pt; }
  th, td { border: 1px solid #c9d8e8; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eef4fa; }
  tr { break-inside: avoid; }
  code { font-family: Consolas, monospace; font-size: 9pt; background: #f1f5f9; padding: 0 2px; }
  pre { background: #f1f5f9; padding: 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
  pre code { background: none; }
  img { max-width: 100%; }
  blockquote { border-left: 3px solid #1767b0; margin-left: 0; padding-left: 10px; color: #4d5b70; }
  .pass { color: #047857; font-weight: 600; } .fail { color: #c81e1e; font-weight: 600; }
`;

export async function markdownToPdf(input, output = input.replace(/\.md$/i, ".pdf")) {
  const markdown = await readFile(input, "utf8");
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? path.basename(input);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<base href="${pathToFileURL(path.dirname(path.resolve(input))).href}/">
<style>${STYLE}</style></head><body>${await marked.parse(markdown)}</body></html>`;

  const browser = BROWSERS.find((b) => b && existsSync(b));
  if (!browser) throw new Error("No Edge or Chrome found. Set PDF_BROWSER to a Chromium-based browser.");

  const work = await mkdtemp(path.join(os.tmpdir(), "bcis-pdf-"));
  try {
    const page = path.join(work, "page.html");
    await writeFile(page, html);
    const result = spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--user-data-dir=${path.join(work, "profile")}`,
        `--print-to-pdf=${path.resolve(output)}`,
        pathToFileURL(page).href,
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
    if (result.error) throw result.error;
    if (!existsSync(output)) throw new Error(`The browser did not write ${output}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error("Usage: node scripts/md-to-pdf.mjs <input.md> [output.pdf]");
    process.exit(1);
  }
  console.log(`Wrote ${await markdownToPdf(input, output)}`);
}
