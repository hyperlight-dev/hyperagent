/**
 * PDF Content Extraction Tests — uses pdftotext (poppler-utils)
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const pdfMod: any = await import("../builtin-modules/pdf.js");

function extractText(doc: any): string {
  const bytes = doc.buildPdf();
  const tmp = join(
    tmpdir(),
    `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
  );
  writeFileSync(tmp, bytes);
  try {
    return execSync(`pdftotext "${tmp}" -`, {
      encoding: "utf-8",
      timeout: 5000,
    });
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function hasPdftotext(): boolean {
  try {
    execSync("which pdftotext", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = !hasPdftotext();
const itP = skip ? it.skip : it;

describe("PDF content extraction (pdftotext)", () => {
  itP("simple drawText", () => {
    const doc = pdfMod.createDocument();
    doc.addPage();
    doc.drawText("Hello World", 72, 72);
    expect(extractText(doc)).toContain("Hello World");
  });

  itP("compressed streams", () => {
    const doc = pdfMod.createDocument({ debug: false });
    doc.addPage();
    doc.drawText("Compressed content here.", 72, 72);
    expect(extractText(doc)).toContain("Compressed content");
  });

  itP("flow layout heading + paragraph", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.heading({ text: "Document Title", level: 1 }),
      pdfMod.paragraph({ text: "First paragraph of content." }),
    ]);
    const text = extractText(doc);
    expect(text).toContain("Document Title");
    expect(text).toContain("First paragraph");
  });

  itP("table content", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.table({
        headers: ["Name", "Score"],
        rows: [
          ["Alice", "95"],
          ["Bob", "87"],
        ],
      }),
    ]);
    const text = extractText(doc);
    expect(text).toContain("Alice");
    expect(text).toContain("95");
  });

  itP("kvTable content", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.kvTable({ items: [{ key: "Company", value: "Acme Corp" }] }),
    ]);
    expect(extractText(doc)).toContain("Acme Corp");
  });

  itP("bullet list", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.bulletList({ items: ["First", "Second", "Third"] }),
    ]);
    const text = extractText(doc);
    expect(text).toContain("First");
    expect(text).toContain("Third");
  });

  itP("code block", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [pdfMod.codeBlock({ code: "const x = 42;" })]);
    expect(extractText(doc)).toContain("const x = 42");
  });

  itP("quote with author", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.quote({ text: "Be the change.", author: "Gandhi" }),
    ]);
    const text = extractText(doc);
    expect(text).toContain("Be the change");
    expect(text).toContain("Gandhi");
  });

  itP("metadata via pdfinfo", () => {
    const doc = pdfMod.createDocument({
      title: "Test Report",
      author: "Author",
    });
    doc.addPage();
    doc.drawText("X", 72, 72);
    const bytes = doc.buildPdf();
    const tmp = join(tmpdir(), `pdfinfo-${Date.now()}.pdf`);
    writeFileSync(tmp, bytes);
    try {
      const info = execSync(`pdfinfo "${tmp}"`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(info).toContain("Test Report");
      expect(info).toContain("Author");
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  });

  itP("complete invoice", () => {
    const doc = pdfMod.createDocument();
    pdfMod.addContent(doc, [
      pdfMod.heading({ text: "INVOICE", level: 1 }),
      pdfMod.kvTable({ items: [{ key: "Number", value: "INV-001" }] }),
      pdfMod.table({
        headers: ["Item", "Amount"],
        rows: [["Consulting", "$5,000"]],
        columnAlign: ["left", "right"],
      }),
      pdfMod.kvTable({ items: [{ key: "Total", value: "$5,000" }] }),
    ]);
    const text = extractText(doc);
    expect(text).toContain("INVOICE");
    expect(text).toContain("INV-001");
    expect(text).toContain("Consulting");
    expect(text).toContain("$5,000");
  });
});
