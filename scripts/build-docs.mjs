// Renders the documentation PDFs (deliverable D3):
//   docs/technical-documentation.pdf  the document, then the ERD, data dictionary and API reference
//   docs/erd.pdf                      the ERD on its own (spec 9.1 folder layout)
//
//   pnpm docs:build   (regenerates docs/generated first, from the code and the migrated test database)
import { markdownToPdf } from "./md-to-pdf.mjs";

const generated = ["docs/generated/erd.md", "docs/generated/data-dictionary.md", "docs/generated/api-reference.md"];
console.log(`Wrote ${await markdownToPdf(["docs/technical-documentation.md", ...generated], "docs/technical-documentation.pdf")}`);
console.log(`Wrote ${await markdownToPdf("docs/generated/erd.md", "docs/erd.pdf")}`);
