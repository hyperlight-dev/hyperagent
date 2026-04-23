/**
 * PDF Visual Regression Tests (Phase 8)
 *
 * Generates deterministic fixture PDFs, renders to PNG via pdftoppm,
 * and compares against golden baselines using pixelmatch.
 *
 * Golden baselines live in tests/golden/pdf/ and are committed to git.
 * To regenerate: UPDATE_GOLDEN=1 npx vitest run tests/pdf-visual.test.ts
 *
 * Requires: poppler-utils (pdftoppm), fonts-dejavu-core
 * Skipped on Windows or when poppler-utils is not installed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const pdf: any = await import("../builtin-modules/pdf.js");

// ── Config ───────────────────────────────────────────────────────────

const GOLDEN_DIR = join(__dirname, "golden", "pdf");
const TEMP_DIR = join(
  process.platform === "win32" ? process.env.TEMP || "C:\\Temp" : "/tmp",
  "pdf-visual-test",
);
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";
const PIXEL_THRESHOLD = 0.1; // per-pixel colour distance threshold
const MAX_DIFF_PIXELS = 50; // fail if more than this many pixels differ

// ── Tool Availability ────────────────────────────────────────────────

// On Windows, WSL commands target a specific distro via PDF_WSL_DISTRO
// to ensure the same poppler/font versions as CI (e.g. Ubuntu-22.04).
const WSL_DISTRO = process.env.PDF_WSL_DISTRO;
const WSL_CMD = WSL_DISTRO ? `wsl -d ${WSL_DISTRO}` : "wsl";

/** Check if a command-line tool is available (cross-platform). */
function hasCommand(cmd: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`${WSL_CMD} which ${cmd}`, { stdio: "ignore" });
    } else {
      execSync(`which ${cmd}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

// On Linux: run when pdftoppm is installed (always on CI, opt-in locally).
// On Windows: run when WSL has pdftoppm. Set PDF_WSL_DISTRO to match CI.
const HAS_PDFTOPPM = hasCommand("pdftoppm");

// Lazy-load comparison deps (only imported when pdftoppm is available)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PNG: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pixelmatch: any;
if (HAS_PDFTOPPM) {
  const pngjs = await import("pngjs");
  PNG = pngjs.PNG;
  const pm = await import("pixelmatch");
  pixelmatch = pm.default ?? pm;
}

if (!HAS_PDFTOPPM && process.platform !== "win32") {
  console.warn(
    "\n⚠️  WARNING: pdftoppm not available — skipping visual regression tests." +
      "\n   Install with: sudo apt-get install poppler-utils fonts-dejavu-core\n",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Ensure temp directory exists. */
function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

/** Convert a Windows path to a WSL path (e.g. C:\foo → /mnt/c/foo). */
function toWslPath(winPath: string): string {
  const resolved = winPath.replace(/\\/g, "/");
  const match = resolved.match(/^([A-Za-z]):\/(.*)/);
  if (!match) return resolved;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/** Write PDF bytes to file and render page 1 to PNG via pdftoppm. */
function renderPage1(pdfBytes: Uint8Array, name: string): Buffer {
  ensureTempDir();
  const pdfPath = join(TEMP_DIR, `${name}.pdf`);
  const pngPrefix = join(TEMP_DIR, `${name}`);
  writeFileSync(pdfPath, pdfBytes);

  if (process.platform === "win32") {
    // Run pdftoppm via WSL, converting Windows paths to Linux paths
    const wslPdf = toWslPath(pdfPath);
    const wslPrefix = toWslPath(pngPrefix);
    execSync(
      `${WSL_CMD} pdftoppm -png -r 150 -singlefile "${wslPdf}" "${wslPrefix}"`,
      {
        timeout: 10000,
      },
    );
  } else {
    execSync(`pdftoppm -png -r 150 -singlefile "${pdfPath}" "${pngPrefix}"`, {
      timeout: 10000,
    });
  }

  const pngPath = `${pngPrefix}.png`;
  return readFileSync(pngPath);
}

/** Compare a rendered PNG against its golden baseline. */
function compareWithGolden(pngBuffer: Buffer, name: string): void {
  const goldenPath = join(GOLDEN_DIR, `${name}.png`);

  if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
    // Write new golden baseline
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, pngBuffer);
    console.log(`  📸 Updated golden: ${goldenPath}`);
    return;
  }

  // Compare with existing golden
  const actual = PNG.sync.read(pngBuffer);
  const expected = PNG.sync.read(readFileSync(goldenPath));

  // Size must match
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);

  const diff = new PNG({ width: actual.width, height: actual.height });
  const numDiffPixels = pixelmatch(
    actual.data,
    expected.data,
    diff.data,
    actual.width,
    actual.height,
    { threshold: PIXEL_THRESHOLD },
  );

  if (numDiffPixels > MAX_DIFF_PIXELS) {
    // Write diff image for debugging
    const diffPath = join(TEMP_DIR, `${name}-diff.png`);
    writeFileSync(diffPath, PNG.sync.write(diff));
    throw new Error(
      `Visual regression: ${name} has ${numDiffPixels} different pixels ` +
        `(threshold: ${MAX_DIFF_PIXELS}). Diff image: ${diffPath}`,
    );
  }
}

// ── Fixture Generators ───────────────────────────────────────────────
// Each fixture creates a deterministic PDF testing a specific feature.
// No dates, no random content — same input = same output always.

function fixtureText(): Uint8Array {
  const doc = pdf.createDocument({ theme: "light-clean", debug: true });
  doc.addPage();
  pdf.addContent(doc, [
    pdf.heading({ text: "Text Rendering Test", level: 1 }),
    pdf.paragraph({ text: "Regular paragraph text in Helvetica 11pt." }),
    pdf.paragraph({ text: "**Bold inline** text using markdown markers." }),
    pdf.paragraph({
      text: "Italic text with oblique font.",
      italic: true,
    }),
    pdf.paragraph({
      text: "Right-aligned paragraph for layout testing.",
      align: "right",
    }),
    pdf.sectionHeading({ text: "Section Heading" }),
    pdf.paragraph({ text: "Text after a section heading with rule." }),
  ]);
  return doc.buildPdf();
}

function fixtureTable(): Uint8Array {
  const doc = pdf.createDocument({ theme: "corporate-blue", debug: true });
  doc.addPage();
  pdf.addContent(doc, [
    pdf.heading({ text: "Table Test" }),
    pdf.table({
      headers: ["Name", "Role", "Score"],
      rows: [
        ["Alice", "Engineer", "95"],
        ["Bob", "Designer", "88"],
        ["Carol", "Manager", "92"],
      ],
      style: "corporate",
      footerRow: ["Average", "", "91.7"],
    }),
    pdf.kvTable({
      items: [
        { key: "Total", value: "275" },
        { key: "Average", value: "91.7", bold: true, separator: true },
      ],
    }),
  ]);
  return doc.buildPdf();
}

function fixtureTwoColumn(): Uint8Array {
  const doc = pdf.createDocument({ theme: "light-clean", debug: true });
  doc.addPage();
  pdf.addContent(doc, [
    pdf.heading({ text: "Two Column Layout" }),
    pdf.twoColumn({
      left: [
        pdf.paragraph({ text: "Left column content here." }),
        pdf.bulletList({ items: ["Item A", "Item B", "Item C"] }),
      ],
      right: [
        pdf.paragraph({ text: "Right column content." }),
        pdf.numberedList({ items: ["First", "Second", "Third"] }),
      ],
      ratio: 0.5,
    }),
  ]);
  return doc.buildPdf();
}

function fixtureCalloutBox(): Uint8Array {
  const doc = pdf.createDocument({ theme: "dark-navy", debug: true });
  doc.addPage();
  // Fill dark background
  doc.drawRect(0, 0, doc.pageSize.width, doc.pageSize.height, {
    fill: doc.theme.bg,
  });
  pdf.addContent(doc, [
    pdf.heading({ text: "Callout Box on Dark Theme", color: "FFFFFF" }),
    pdf.calloutBox({
      title: "Important Note",
      text: "This callout box should be readable on a dark background.",
    }),
    pdf.calloutBox({
      text: "No title callout — just body text with default styling.",
    }),
  ]);
  return doc.buildPdf();
}

function fixtureTitlePage(): Uint8Array {
  const doc = pdf.createDocument({ theme: "light-clean", debug: true });
  pdf.titlePage(doc, {
    title: "Visual Regression Test Document",
    subtitle: "Testing title page layout and word wrapping",
    author: "HyperAgent Test Suite",
  });
  return doc.buildPdf();
}

function fixtureSignature(): Uint8Array {
  const doc = pdf.createDocument({ theme: "light-clean", debug: true });
  doc.addPage();
  pdf.addContent(doc, [
    pdf.paragraph({ text: "Sincerely," }),
    pdf.signatureLine({ name: "Jane Smith", title: "VP Engineering" }),
  ]);
  return doc.buildPdf();
}

// ── Tests ────────────────────────────────────────────────────────────

const fixtures: [string, () => Uint8Array][] = [
  ["text-rendering", fixtureText],
  ["table-styles", fixtureTable],
  ["two-column", fixtureTwoColumn],
  ["callout-dark", fixtureCalloutBox],
  ["title-page", fixtureTitlePage],
  ["signature-line", fixtureSignature],
];

describe.skipIf(!HAS_PDFTOPPM)("PDF visual regression", () => {
  for (const [name, generator] of fixtures) {
    it(`should match golden baseline: ${name}`, () => {
      const pdfBytes = generator();
      const pngBuffer = renderPage1(pdfBytes, name);
      compareWithGolden(pngBuffer, name);
    });
  }
});
