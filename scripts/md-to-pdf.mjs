// Renders a Markdown file to PDF with headless Microsoft Edge
// or Chrome, so the deliverables in docs/ and tests/ can be written as diffable Markdown.
//
//   node scripts/md-to-pdf.mjs <input.md> [more.md ...] [-o output.pdf]
//
// ```mermaid code blocks are drawn as diagrams.
//
// The browser is found in the usual install folders; set PDF_BROWSER to override.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  .mermaid { text-align: center; break-inside: avoid; background: none; }
  .mermaid svg { max-width: 100%; max-height: 215mm; }
  .page-break { break-before: page; }
`;

const MERMAID = fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));

// ```mermaid blocks become diagrams; mermaid.js (from node_modules, so no network) draws them
// in the page before it is printed.
const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
marked.use({
  renderer: {
    code({ text, lang }) {
      return lang === "mermaid" ? `<pre class="mermaid">${escapeHtml(text)}</pre>` : false;
    },
  },
});

/**
 * Renders one Markdown file, or several joined with page breaks, into one PDF. Relative links
 * and images resolve from the first file's folder.
 */
export async function markdownToPdf(inputs, output) {
  const files = [inputs].flat();
  const target = output ?? files[0].replace(/\.md$/i, ".pdf");
  const parts = await Promise.all(files.map((f) => readFile(f, "utf8")));
  const title = /^#\s+(.+)$/m.exec(parts[0])?.[1] ?? path.basename(files[0]);
  const body = parts
    .map((p) => marked.parse(p, { async: false }))
    .map((html, i) => (i === 0 ? html : `<div class="page-break"></div>${html}`))
    .join("\n");
  const diagrams = parts.some((p) => p.includes("```mermaid"));
  const scripts = diagrams
    ? `<script src="${pathToFileURL(MERMAID).href}"></script>
<script>
  // One diagram at a time, after the font is loaded, so text is measured before layout.
  // deterministicIds: ids are numbered, not taken from the clock, which the print run freezes.
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict", deterministicIds: true,
    themeVariables: { fontFamily: "Segoe UI, Arial, sans-serif" } });
  document.fonts.ready.then(() => mermaid.run({ querySelector: ".mermaid" }));
</script>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<base href="${pathToFileURL(path.dirname(path.resolve(files[0]))).href}/">
<style>${STYLE}</style></head><body>${body}${scripts}</body></html>`;

  const browser = BROWSERS.find((b) => b && existsSync(b));
  if (!browser) throw new Error("No Edge or Chrome found. Set PDF_BROWSER to a Chromium-based browser.");

  const work = await mkdtemp(path.join(os.tmpdir(), "bcis-pdf-"));
  try {
    const page = path.join(work, "page.html");
    await writeFile(page, html);
    if (process.env.PDF_KEEP_HTML) await writeFile(process.env.PDF_KEEP_HTML, html); // for debugging layout
    const result = spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--allow-file-access-from-files",
        // Time for mermaid.js to draw the diagrams before the page is printed.
        ...(diagrams ? ["--virtual-time-budget=30000", "--run-all-compositor-stages-before-draw"] : []),
        `--user-data-dir=${path.join(work, "profile")}`,
        `--print-to-pdf=${path.resolve(target)}`,
        pathToFileURL(page).href,
      ],
      { stdio: "ignore", timeout: 180_000 },
    );
    if (result.error) throw result.error;
    if (!existsSync(target)) throw new Error(`The browser did not write ${target}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("-o");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const inputs = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (inputs.length === 0) {
    console.error("Usage: node scripts/md-to-pdf.mjs <input.md> [more.md ...] [-o output.pdf]");
    process.exit(1);
  }
  console.log(`Wrote ${await markdownToPdf(inputs, output)}`);
}
