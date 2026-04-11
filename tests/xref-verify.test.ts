import { it, expect } from "vitest";
import { writeFileSync, readFileSync } from "fs";

const pdf: any = await import("../builtin-modules/pdf.js");

it("xref byte offsets are correct", () => {
  const doc = pdf.createDocument();
  doc.addPage();
  doc.drawText("Hello", 72, 100);
  const bytes = doc.buildPdf();
  writeFileSync("/tmp/xref-verify.pdf", bytes);

  // Read the PDF as text
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);

  // Extract xref entries
  const xrefStart = text.indexOf("xref\n");
  const xrefSection = text.substring(xrefStart);
  const entries = xrefSection.match(/(\d{10}) (\d{5}) ([nf]) /g);
  
  console.log("=== XREF ENTRIES ===");
  entries?.forEach((e, i) => console.log(`  obj ${i}: ${e}`));

  // Verify each 'n' entry points to "N 0 obj"
  entries?.forEach((entry, i) => {
    if (i === 0) return; // object 0 is free
    const parts = entry.match(/(\d{10}) (\d{5}) ([nf])/);
    if (!parts) return;
    const offset = parseInt(parts[1], 10);
    const type = parts[3];
    if (type === 'f') {
      console.log(`  obj ${i}: FREE`);
      return;
    }
    // Check that the text at this offset starts with "N 0 obj"
    const atOffset = text.substring(offset, offset + 20);
    const expected = `${i} 0 obj`;
    console.log(`  obj ${i}: offset=${offset}, found="${atOffset.replace(/\n/g, '\\n')}"`);
    expect(atOffset.startsWith(expected), 
      `Object ${i} at offset ${offset} should start with "${expected}" but found "${atOffset}"`
    ).toBe(true);
  });
});
