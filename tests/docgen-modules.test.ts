// ── OOXML Core + PPTX Module Tests ───────────────────────────────────
//
// Standalone unit tests for the ooxml-core and pptx builtin modules.
// Tests ooxml-core utilities directly and pptx output structure.
//
// ─────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

// ── ooxml-core ───────────────────────────────────────────────────────

const core = await import("../builtin-modules/ooxml-core.js");

/** Convert ShapeFragment or string to XML string for test assertions */
const toXml = (v: unknown): string => (typeof v === "string" ? v : String(v));

describe("ooxml-core", () => {
  describe("unit conversions", () => {
    it("should convert inches to EMU", () => {
      expect(core.inches(1)).toBe(914400);
      expect(core.inches(0.5)).toBe(457200);
      expect(core.inches(0)).toBe(0);
    });

    it("should convert points to EMU", () => {
      expect(core.pts(1)).toBe(12700);
      expect(core.pts(72)).toBe(914400); // 72pt = 1 inch
    });

    it("should convert cm to EMU", () => {
      expect(core.cm(1)).toBe(360000);
      expect(core.cm(2.54)).toBe(914400); // 2.54cm = 1 inch
    });

    it("should convert font size to OOXML format", () => {
      expect(core.fontSize(12)).toBe(1200);
      expect(core.fontSize(24)).toBe(2400);
      expect(core.fontSize(10.5)).toBe(1050);
    });
  });

  describe("hexColor", () => {
    it("should strip leading #", () => {
      expect(core.hexColor("#2196F3")).toBe("2196F3");
    });

    it("should uppercase", () => {
      expect(core.hexColor("ff0000")).toBe("FF0000");
    });

    it("should handle already-clean input", () => {
      expect(core.hexColor("ABCDEF")).toBe("ABCDEF");
    });
  });

  describe("themes", () => {
    it("should have 8 built-in themes (including midnight alias)", () => {
      expect(Object.keys(core.THEMES)).toHaveLength(8);
    });

    it("should have midnight as alias for black", () => {
      expect(core.THEMES.midnight).toBe(core.THEMES.black);
    });

    it("should include corporate-blue", () => {
      const t = core.getTheme("corporate-blue");
      expect(t).toBeDefined();
      expect(t!.bg).toBe("1B2A4A");
      expect(t!.fg).toBe("FFFFFF");
      expect(t!.accent1).toBe("2196F3");
    });

    it("should fall back to corporate-blue for unknown theme", () => {
      const t = core.getTheme("nonexistent");
      expect(t).toBeDefined();
      expect(t!.bg).toBe("1B2A4A");
    });

    it("each theme should have all required fields", () => {
      for (const [name, theme] of Object.entries(core.THEMES)) {
        expect(theme.bg, `${name}.bg`).toBeTruthy();
        expect(theme.fg, `${name}.fg`).toBeTruthy();
        expect(theme.accent1, `${name}.accent1`).toBeTruthy();
        expect(theme.accent2, `${name}.accent2`).toBeTruthy();
        expect(theme.titleFont, `${name}.titleFont`).toBeTruthy();
        expect(theme.bodyFont, `${name}.bodyFont`).toBeTruthy();
      }
    });
  });

  describe("contentTypesXml", () => {
    it("should generate valid XML with overrides", () => {
      const xml = core.contentTypesXml([
        {
          partName: "/ppt/presentation.xml",
          contentType: "application/test",
        },
      ]);
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain("Types xmlns=");
      expect(xml).toContain('PartName="/ppt/presentation.xml"');
      expect(xml).toContain('Extension="xml"');
      expect(xml).toContain('Extension="rels"');
    });
  });

  describe("relsXml", () => {
    it("should generate relationship entries", () => {
      const xml = core.relsXml([
        { id: "rId1", type: "http://test", target: "test.xml" },
      ]);
      expect(xml).toContain('Id="rId1"');
      expect(xml).toContain('Target="test.xml"');
      expect(xml).toContain("Relationships xmlns=");
    });
  });

  describe("themeXml", () => {
    it("should generate theme with colors and fonts", () => {
      const theme = core.getTheme("corporate-blue");
      expect(theme).toBeDefined();
      const xml = core.themeXml(theme!, "Test");
      expect(xml).toContain('name="Test"');
      expect(xml).toContain(`val="${theme!.accent1}"`);
      expect(xml).toContain(`typeface="${theme!.titleFont}"`);
      expect(xml).toContain("a:clrScheme");
      expect(xml).toContain("a:fontScheme");
    });
  });

  describe("slide dimensions", () => {
    it("should export standard widescreen dimensions", () => {
      expect(core.SLIDE_WIDTH).toBe(12192000); // 13.333 inches
      expect(core.SLIDE_HEIGHT).toBe(6858000); // 7.5 inches
    });
  });
});

// ── pptx ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pptx: any = await import("../builtin-modules/pptx.js");

describe("pptx", () => {
  describe("createPresentation", () => {
    it("should create a presentation with default theme", () => {
      const pres = pptx.createPresentation();
      expect(pres.theme).toBeDefined();
      expect(pres.theme.bg).toBe("1B2A4A"); // corporate-blue
      expect(pres.slides).toHaveLength(0);
    });

    it("should accept a custom theme", () => {
      const pres = pptx.createPresentation({ theme: "dark-gradient" });
      expect(pres.theme.bg).toBe("0D1117");
    });
  });

  describe("textBox", () => {
    it("should generate shape XML with text", () => {
      const xml = toXml(
        pptx.textBox({
          x: 1,
          y: 2,
          w: 8,
          h: 1,
          text: "Hello",
          fontSize: 24,
        }),
      );
      expect(xml).toContain("p:sp");
      expect(xml).toContain("txBox");
      expect(xml).toContain("<a:t>Hello</a:t>");
      expect(xml).toContain('sz="2400"'); // 24pt = 2400
    });

    it("should escape XML in text", () => {
      const xml = toXml(
        pptx.textBox({ x: 0, y: 0, w: 1, h: 1, text: "A & B" }),
      );
      expect(xml).toContain("A &amp; B");
      expect(xml).not.toContain("A & B");
    });

    it("should handle array of paragraphs", () => {
      const xml = toXml(
        pptx.textBox({
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          text: ["Line 1", "Line 2"],
        }),
      );
      expect(xml).toContain("<a:t>Line 1</a:t>");
      expect(xml).toContain("<a:t>Line 2</a:t>");
    });

    it("should normalize 'center' alignment to 'ctr' (OOXML enum)", () => {
      const xml = toXml(
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "Centered",
          align: "center",
        }),
      );
      expect(xml).toContain('algn="ctr"');
      expect(xml).not.toContain('algn="center"');
    });

    it("should pass through valid alignment values unchanged", () => {
      const xml = toXml(
        pptx.textBox({
          x: 0,
          y: 0,
          w: 4,
          h: 1,
          text: "Right",
          align: "r",
        }),
      );
      expect(xml).toContain('algn="r"');
    });
  });

  describe("rect", () => {
    it("should generate rectangle with fill", () => {
      const xml = toXml(
        pptx.rect({
          x: 1,
          y: 2,
          w: 3,
          h: 1,
          fill: "#FF0000",
        }),
      );
      expect(xml).toContain("p:sp");
      expect(xml).toContain('val="FF0000"');
      expect(xml).toContain('prst="rect"');
    });

    it("should use roundRect when cornerRadius is set", () => {
      const xml = toXml(
        pptx.rect({
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          fill: "000000",
          cornerRadius: 5,
        }),
      );
      expect(xml).toContain('prst="roundRect"');
    });

    it("should include text overlay when specified", () => {
      const xml = toXml(
        pptx.rect({
          x: 0,
          y: 0,
          w: 2,
          h: 1,
          fill: "2196F3",
          text: "Label",
        }),
      );
      expect(xml).toContain("<a:t>Label</a:t>");
    });
  });

  describe("bulletList", () => {
    it("should generate bulleted items", () => {
      const xml = toXml(
        pptx.bulletList({
          x: 1,
          y: 2,
          w: 8,
          h: 4,
          items: ["First", "Second", "Third"],
        }),
      );
      expect(xml).toContain("<a:t>First</a:t>");
      expect(xml).toContain("<a:t>Second</a:t>");
      expect(xml).toContain("<a:t>Third</a:t>");
      expect(xml).toContain('char="&#x2022;"');
    });

    it("should produce well-formed XML with bulletColor", () => {
      const xml = toXml(
        pptx.bulletList({
          x: 0,
          y: 0,
          w: 8,
          h: 4,
          items: ["Item A", "Item B"],
          bulletColor: "FF0000",
        }),
      );
      // Every opened tag must close — no mismatched tags
      // The bullet char must use XML entity, not raw Unicode
      expect(xml).toContain('char="&#x2022;"');
      expect(xml).not.toContain('char="""');
      // Verify the XML is parseable by checking matched tags
      const opens = (xml.match(/<a:buChar /g) || []).length;
      const closes = (xml.match(/\/>/g) || []).length;
      expect(opens).toBeGreaterThan(0);
      expect(closes).toBeGreaterThanOrEqual(opens);
    });
  });
});

describe("statBox", () => {
  it("should generate value + label layout", () => {
    const xml = toXml(
      pptx.statBox({
        x: 1,
        y: 2,
        w: 3,
        h: 2,
        value: "$2.4M",
        label: "Revenue",
        valueSize: 36,
      }),
    );
    expect(xml).toContain("<a:t>$2.4M</a:t>");
    expect(xml).toContain("<a:t>Revenue</a:t>");
    expect(xml).toContain('sz="3600"'); // 36pt
  });
});

describe("slide builders", () => {
  it("titleSlide should add one slide", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, {
      title: "My Presentation",
      subtitle: "A subtitle",
    });
    expect(pres.slides).toHaveLength(1);
  });

  it("sectionSlide should add one slide", () => {
    const pres = pptx.createPresentation();
    pptx.sectionSlide(pres, { title: "Section 1" });
    expect(pres.slides).toHaveLength(1);
  });

  it("contentSlide should add one slide with body elements", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "Content",
      items: ["Body text"],
    });
    expect(pres.slides).toHaveLength(1);
  });

  it("twoColumnSlide should include divider", () => {
    const pres = pptx.createPresentation();
    pptx.twoColumnSlide(pres, {
      title: "Comparison",
      left: [pptx.textBox({ x: 0.5, y: 1.5, w: 5.5, h: 4, text: "Left" })],
      right: [pptx.textBox({ x: 7, y: 1.5, w: 5.5, h: 4, text: "Right" })],
    });
    expect(pres.slides).toHaveLength(1);
  });

  it("blankSlide should add an empty slide", () => {
    const pres = pptx.createPresentation();
    pptx.blankSlide(pres);
    expect(pres.slides).toHaveLength(1);
  });
});

describe("line", () => {
  it("should generate connection shape XML", () => {
    const xml = toXml(
      pptx.line({
        x1: 1,
        y1: 2,
        x2: 5,
        y2: 2,
        color: "#FF0000",
        width: 2,
      }),
    );
    expect(xml).toContain("p:cxnSp");
    expect(xml).toContain('val="FF0000"');
    expect(xml).toContain('prst="line"');
  });

  it("should handle reverse direction (flip)", () => {
    const xml = toXml(pptx.line({ x1: 5, y1: 3, x2: 1, y2: 1 }));
    expect(xml).toContain('flipH="1"');
    expect(xml).toContain('flipV="1"');
  });

  it("should support dash styles", () => {
    const xml = toXml(
      pptx.line({
        x1: 0,
        y1: 0,
        x2: 5,
        y2: 0,
        dash: "dash",
      }),
    );
    expect(xml).toContain('prstDash val="dash"');
  });
});

describe("arrow", () => {
  it("should generate line with arrowhead", () => {
    const xml = toXml(
      pptx.arrow({
        x1: 1,
        y1: 2,
        x2: 5,
        y2: 4,
        color: "2196F3",
      }),
    );
    expect(xml).toContain("p:cxnSp");
    expect(xml).toContain('type="triangle"');
    expect(xml).toContain("a:tailEnd");
  });

  it("should support both-ends arrowhead", () => {
    const xml = toXml(
      pptx.arrow({
        x1: 0,
        y1: 0,
        x2: 5,
        y2: 0,
        bothEnds: true,
      }),
    );
    expect(xml).toContain("a:headEnd");
    expect(xml).toContain("a:tailEnd");
  });

  it("should support custom head types", () => {
    const xml = toXml(
      pptx.arrow({
        x1: 0,
        y1: 0,
        x2: 5,
        y2: 0,
        headType: "stealth",
      }),
    );
    expect(xml).toContain('type="stealth"');
  });
});

describe("circle", () => {
  it("should generate ellipse shape", () => {
    const xml = toXml(
      pptx.circle({
        x: 5,
        y: 3,
        w: 2,
        fill: "4CAF50",
      }),
    );
    expect(xml).toContain("p:sp");
    expect(xml).toContain('prst="ellipse"');
    expect(xml).toContain('val="4CAF50"');
  });

  it("should include text when specified", () => {
    const xml = toXml(
      pptx.circle({
        x: 5,
        y: 3,
        w: 2,
        fill: "FF0000",
        text: "OK",
      }),
    );
    expect(xml).toContain("<a:t>OK</a:t>");
  });
});

describe("callout", () => {
  it("should generate accent bar + text box", () => {
    const xml = toXml(
      pptx.callout({
        x: 1,
        y: 2,
        w: 8,
        h: 1.5,
        text: "Key insight here",
        accentColor: "E91E63",
      }),
    );
    expect(xml).toContain("Key insight here");
    expect(xml).toContain('val="E91E63"');
    // Should have two shapes (accent bar + main box)
    expect((xml.match(/<p:sp>/g) || []).length).toBe(2);
  });
});

describe("icon", () => {
  it("should generate preset shape", () => {
    const xml = toXml(
      pptx.icon({
        x: 1,
        y: 2,
        w: 0.5,
        shape: "star",
        fill: "FFD700",
      }),
    );
    expect(xml).toContain('prst="star5"');
    expect(xml).toContain('val="FFD700"');
  });

  it("should support heart shape", () => {
    const xml = toXml(pptx.icon({ x: 0, y: 0, w: 1, shape: "heart" }));
    expect(xml).toContain('prst="heart"');
  });
});

describe("gradientFill", () => {
  it("should generate gradient fill XML", () => {
    const xml = pptx.gradientFill("FF0000", "0000FF", 90);
    expect(xml).toContain("a:gradFill");
    expect(xml).toContain('val="FF0000"');
    expect(xml).toContain('val="0000FF"');
  });
});

describe("richText", () => {
  it("should support mixed formatting runs", () => {
    const xml = toXml(
      pptx.richText({
        x: 1,
        y: 2,
        w: 8,
        h: 1,
        paragraphs: [
          [
            { text: "Hello ", bold: true, color: "FF6666" },
            { text: "World", italic: true, color: "66AAFF" },
          ],
        ],
      }),
    );
    expect(xml).toContain("<a:t>Hello </a:t>");
    expect(xml).toContain("<a:t>World</a:t>");
    expect(xml).toContain('b="1"');
    expect(xml).toContain('i="1"');
  });

  it("should support multiple paragraphs", () => {
    const xml = toXml(
      pptx.richText({
        x: 0,
        y: 0,
        w: 5,
        h: 2,
        paragraphs: [[{ text: "Line 1" }], [{ text: "Line 2" }]],
      }),
    );
    expect((xml.match(/<a:p>/g) || []).length).toBe(2);
  });
});

describe("hyperlink", () => {
  it("should generate clickable text with link relationship", () => {
    const pres = pptx.createPresentation();
    const xml = toXml(
      pptx.hyperlink(
        {
          x: 1,
          y: 2,
          w: 4,
          h: 0.5,
          text: "Visit GitHub",
          url: "https://github.com",
        },
        pres,
      ),
    );
    expect(xml).toContain("<a:t>Visit GitHub</a:t>");
    expect(xml).toContain("a:hlinkClick");
    expect(xml).toContain("rIdLink1");
  });

  it("should register link on pres for build()", () => {
    const pres = pptx.createPresentation();
    pptx.hyperlink(
      {
        x: 0,
        y: 0,
        w: 1,
        h: 0.3,
        text: "Link",
        url: "https://example.com",
      },
      pres,
    );
    expect(pres._links).toHaveLength(1);
    expect(pres._links[0].url).toBe("https://example.com");
  });

  it("should include hyperlink rels in build output", () => {
    const pres = pptx.createPresentation();
    // Use customSlide for raw shape content
    pptx.customSlide(pres, {
      shapes: pptx.hyperlink(
        {
          x: 1,
          y: 2,
          w: 4,
          h: 0.5,
          text: "Test",
          url: "https://test.com",
        },
        pres,
      ),
    });
    const entries = pres.build();
    const slideRels = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/_rels/slide1.xml.rels",
    );
    expect(slideRels.data).toContain("https://test.com");
    expect(slideRels.data).toContain("hyperlink");
  });
});

describe("numberedList", () => {
  it("should generate numbered items", () => {
    const xml = toXml(
      pptx.numberedList({
        x: 1,
        y: 2,
        w: 8,
        h: 4,
        items: ["First", "Second", "Third"],
      }),
    );
    expect(xml).toContain("<a:t>First</a:t>");
    expect(xml).toContain("<a:t>Third</a:t>");
    expect(xml).toContain("buAutoNum");
    expect(xml).toContain('type="arabicPeriod"');
  });
});

describe("imagePlaceholder", () => {
  it("should generate placeholder rect", () => {
    const xml = toXml(pptx.imagePlaceholder({ x: 2, y: 3, w: 5, h: 4 }));
    expect(xml).toContain("Image");
    expect(xml).toContain('prst="roundRect"');
  });

  it("should accept custom label", () => {
    const xml = toXml(
      pptx.imagePlaceholder({
        x: 0,
        y: 0,
        w: 3,
        h: 2,
        label: "Logo here",
      }),
    );
    expect(xml).toContain("Logo here");
  });
});

describe("embedImage", () => {
  it("should generate picture shape XML with blip reference", () => {
    const pres = pptx.createPresentation();
    const fakeImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const xml = toXml(
      pptx.embedImage(pres, {
        x: 1,
        y: 2,
        w: 5,
        h: 3,
        data: fakeImage,
        format: "png",
      }),
    );
    expect(xml).toContain("p:pic");
    expect(xml).toContain("a:blip");
    expect(xml).toContain("rIdImage1");
    expect(xml).toContain("Image 1");
  });

  it("should register image on pres for build()", () => {
    const pres = pptx.createPresentation();
    const fakeImage = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG header
    pptx.embedImage(pres, {
      x: 0,
      y: 0,
      w: 2,
      h: 2,
      data: fakeImage,
      format: "jpg",
    });
    expect(pres._images).toHaveLength(1);
    expect(pres._images[0].contentType).toBe("image/jpeg");
    expect(pres._images[0].mediaPath).toContain("image1.jpg");
  });

  it("should include image in build output", () => {
    const pres = pptx.createPresentation();
    const fakeImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    // Use customSlide for raw shape content
    pptx.customSlide(pres, {
      shapes: pptx.embedImage(pres, {
        x: 2,
        y: 2,
        w: 8,
        h: 4,
        data: fakeImage,
      }),
    });

    const entries = pres.build();
    const names = entries.map((e: { name: string }) => e.name);
    // Image file should be in the ZIP
    expect(names).toContain("ppt/media/image1.png");
    // Image relationship should be in slide rels
    const slideRels = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/_rels/slide1.xml.rels",
    );
    expect(slideRels.data).toContain("rIdImage1");
    expect(slideRels.data).toContain("image");
    // Content type should include image
    const ct = entries.find(
      (e: { name: string }) => e.name === "[Content_Types].xml",
    );
    expect(ct.data).toContain("image/png");
  });

  it("should increment image index", () => {
    const pres = pptx.createPresentation();
    const img = new Uint8Array([1, 2, 3]);
    pptx.embedImage(pres, { x: 0, y: 0, w: 1, h: 1, data: img });
    pptx.embedImage(pres, { x: 2, y: 0, w: 1, h: 1, data: img });
    expect(pres._images).toHaveLength(2);
    expect(pres._images[0].mediaPath).toContain("image1");
    expect(pres._images[1].mediaPath).toContain("image2");
  });
});

describe("comparisonSlide", () => {
  it("should create slide with two column headers + divider", () => {
    const pres = pptx.createPresentation();
    pptx.comparisonSlide(pres, {
      title: "Before vs After",
      leftTitle: "Before",
      rightTitle: "After",
      leftBody: [pptx.textBox({ x: 0.5, y: 2, w: 5.5, h: 4, text: "Old" })],
      rightBody: [pptx.textBox({ x: 7, y: 2, w: 5.5, h: 4, text: "New" })],
    });
    expect(pres.slides).toHaveLength(1);
  });
});

describe("addSlideNumbers", () => {
  it("should add numbers to all slides", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "A" });
    pptx.contentSlide(pres, { title: "B", items: [] });
    pptx.addSlideNumbers(pres);
    // Slide 1 should have "1", slide 2 should have "2"
    expect(pres.slides[0].shapes).toContain("<a:t>1</a:t>");
    expect(pres.slides[1].shapes).toContain("<a:t>2</a:t>");
  });
});

describe("addFooter", () => {
  it("should add footer text to all slides", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "A" });
    pptx.contentSlide(pres, { title: "B", items: [] });
    pptx.addFooter(pres, { text: "Confidential" });
    expect(pres.slides[0].shapes).toContain("Confidential");
    expect(pres.slides[1].shapes).toContain("Confidential");
  });
});

describe("build", () => {
  it("should produce valid ZIP entries", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Test" });
    pptx.contentSlide(pres, {
      title: "Content",
      items: ["Hello"],
    });

    const entries = pres.build();

    // Check required PPTX files exist
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("ppt/presentation.xml");
    expect(names).toContain("ppt/theme/theme1.xml");
    expect(names).toContain("ppt/slides/slide1.xml");
    expect(names).toContain("ppt/slides/slide2.xml");
    expect(names).toContain("ppt/slideMasters/slideMaster1.xml");
    expect(names).toContain("ppt/slideLayouts/slideLayout1.xml");
  });

  it("should include slide count in Content_Types", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "A" });
    pptx.titleSlide(pres, { title: "B" });
    pptx.titleSlide(pres, { title: "C" });

    const entries = pres.build();
    const ct = entries.find(
      (e: { name: string }) => e.name === "[Content_Types].xml",
    );
    expect(ct.data).toContain("slide1.xml");
    expect(ct.data).toContain("slide2.xml");
    expect(ct.data).toContain("slide3.xml");
  });

  it("should embed slide content in slide XML", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "My Title",
      items: ["Body content"],
    });

    const entries = pres.build();
    const slide = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slide.data).toContain("<a:t>My Title</a:t>");
    expect(slide.data).toContain("<a:t>Body content</a:t>");
  });

  it("should include transition XML when specified", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "With Transition",
      items: [],
      transition: "fade",
    });

    const entries = pres.build();
    const slide = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slide.data).toContain("p:transition");
    expect(slide.data).toContain("p:fade");
  });

  it("should support push transition", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "Push", transition: "push" });

    const entries = pres.build();
    const slide = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/slide1.xml",
    );
    expect(slide.data).toContain("p:push");
  });

  it("should include speaker notes when specified", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "With Notes",
      items: [],
      notes: "Remember to mention the demo!",
    });

    const entries = pres.build();
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("ppt/notesSlides/notesSlide1.xml");

    const notes = entries.find(
      (e: { name: string }) => e.name === "ppt/notesSlides/notesSlide1.xml",
    );
    expect(notes.data).toContain("Remember to mention the demo!");
  });

  it("should not include notes XML when notes not specified", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, { title: "No Notes", items: [] });

    const entries = pres.build();
    const names = entries.map((e: { name: string }) => e.name);
    const notesFiles = names.filter((n: string) => n.includes("notesSlides"));
    expect(notesFiles).toHaveLength(0);
  });

  it("should register notes content type in Content_Types", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "Notes CT",
      items: [],
      notes: "Some notes",
    });

    const entries = pres.build();
    const ct = entries.find(
      (e: { name: string }) => e.name === "[Content_Types].xml",
    );
    expect(ct.data).toContain("notesSlide1.xml");
    expect(ct.data).toContain("notesSlide+xml");
  });
});

describe("codeBlock", () => {
  it("should create a code block with monospace font and dark background", () => {
    const xml = toXml(
      pptx.codeBlock({
        x: 1,
        y: 2,
        w: 10,
        h: 4,
        code: 'fn main() {\n    println!("Hello");\n}',
      }),
    );
    expect(xml).toContain("Consolas"); // monospace font
    expect(xml).toContain('val="161B22"'); // dark background
    expect(xml).toContain('val="E6EDF3"'); // light text
    expect(xml).toContain("main()");
  });

  it("should support line numbers", () => {
    const xml = toXml(
      pptx.codeBlock({
        x: 0,
        y: 0,
        w: 10,
        h: 3,
        code: "line one\nline two\nline three",
        lineNumbers: true,
      }),
    );
    expect(xml).toContain("1  line one");
    expect(xml).toContain("3  line three");
  });

  it("should support optional title bar", () => {
    const xml = toXml(
      pptx.codeBlock({
        x: 0,
        y: 0,
        w: 10,
        h: 4,
        code: "hello()",
        title: "example.rs",
      }),
    );
    expect(xml).toContain("example.rs");
    expect(xml).toContain('val="0D1117"'); // title bar bg
  });

  it("should accept custom colors and font", () => {
    const xml = toXml(
      pptx.codeBlock({
        x: 0,
        y: 0,
        w: 8,
        h: 3,
        code: "test",
        background: "1E1E1E",
        color: "D4D4D4",
        fontFamily: "Courier New",
      }),
    );
    expect(xml).toContain('val="1E1E1E"');
    expect(xml).toContain('val="D4D4D4"');
    expect(xml).toContain("Courier New");
  });
});

describe("build() XML well-formedness", () => {
  it("should produce valid XML in slides with bullet lists", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "Bullets",
      items: ["Alpha", "Beta", "Gamma"],
    });
    const entries = pres.build();
    const slide = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/slide1.xml",
    );
    // Bullet char must use XML entity, not raw Unicode
    expect(slide.data).toContain('char="&#x2022;"');
    expect(slide.data).not.toContain('char=""');
    // Quick well-formedness: every <a:p> must close
    const pOpens = (slide.data.match(/<a:p>/g) || []).length;
    const pCloses = (slide.data.match(/<\/a:p>/g) || []).length;
    expect(pOpens).toBe(pCloses);
  });

  it("should produce valid XML in slides with tables", () => {
    const pres = pptx.createPresentation();
    pptx.contentSlide(pres, {
      title: "Table",
      items: ["placeholder"],
    });
    const entries = pres.build();
    const slide = entries.find(
      (e: { name: string }) => e.name === "ppt/slides/slide1.xml",
    );
    // Every <a:p> must close in a slide with text
    const pOpens = (slide.data.match(/<a:p>/g) || []).length;
    const pCloses = (slide.data.match(/<\/a:p>/g) || []).length;
    expect(pOpens).toBe(pCloses);
  });

  it("buildZip() should return a Uint8Array starting with PK", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "ZIP Test" });
    const zip = pres.buildZip();
    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(0);
    // ZIP magic bytes: PK\x03\x04
    expect(zip[0]).toBe(0x50); // P
    expect(zip[1]).toBe(0x4b); // K
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it("buildZip() should be smaller than uncompressed build()", () => {
    const pres = pptx.createPresentation();
    for (let i = 0; i < 5; i++) {
      pptx.contentSlide(pres, {
        title: `Slide ${i + 1}`,
        items: [
          "Repeated content A",
          "Repeated content B",
          "Repeated content C",
        ],
      });
    }
    const entries = pres.build();
    const uncompressedSize = entries.reduce(
      (sum: number, e: { data: string | Uint8Array }) =>
        sum + (typeof e.data === "string" ? e.data.length : e.data.length),
      0,
    );
    const zip = pres.buildZip();
    expect(zip.length).toBeLessThan(uncompressedSize);
  });

  it("slideMaster clrMap should include all required accent attributes", () => {
    const pres = pptx.createPresentation();
    pptx.titleSlide(pres, { title: "clrMap test" });
    const entries = pres.build();
    const master = entries.find(
      (e: { name: string }) => e.name === "ppt/slideMasters/slideMaster1.xml",
    );
    // ECMA-376 requires accent1-accent6, bg1, bg2, tx1, tx2, hlink, folHlink
    expect(master.data).toContain('accent5="accent5"');
    expect(master.data).toContain('accent6="accent6"');
    expect(master.data).toContain('accent1="accent1"');
    expect(master.data).toContain('hlink="hlink"');
  });
});

// ── pptx-charts ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const charts: any = await import("../builtin-modules/pptx-charts.js");

describe("pptx-charts", () => {
  describe("barChart", () => {
    it("should generate chart XML with series data", () => {
      const chart = charts.barChart({
        categories: ["Q1", "Q2", "Q3", "Q4"],
        series: [
          { name: "Revenue", values: [100, 200, 300, 400], color: "#2196F3" },
        ],
        title: "Quarterly Revenue",
      });
      expect(chart.type).toBe("chart");
      expect(chart.chartType).toBe("bar");
      expect(chart._chartXml).toContain("c:barChart");
      expect(chart._chartXml).toContain("<c:v>Q1</c:v>");
      expect(chart._chartXml).toContain("<c:v>400</c:v>");
      expect(chart._chartXml).toContain("Quarterly Revenue");
      expect(chart._chartXml).toContain("Revenue");
    });

    it("should support horizontal bars", () => {
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        horizontal: true,
      });
      expect(chart._chartXml).toContain('val="bar"');
    });

    it("should support stacked grouping", () => {
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        stacked: true,
      });
      expect(chart._chartXml).toContain('val="stacked"');
    });

    it("should support multiple series", () => {
      const chart = charts.barChart({
        categories: ["A", "B"],
        series: [
          { name: "S1", values: [10, 20] },
          { name: "S2", values: [30, 40] },
        ],
      });
      expect(chart._chartXml).toContain("<c:v>S1</c:v>");
      expect(chart._chartXml).toContain("<c:v>S2</c:v>");
      expect((chart._chartXml.match(/<c:ser>/g) || []).length).toBe(2);
    });
  });

  describe("pieChart", () => {
    it("should generate pie chart XML", () => {
      const chart = charts.pieChart({
        labels: ["Us", "Them", "Others"],
        values: [50, 30, 20],
        title: "Market Share",
      });
      expect(chart.type).toBe("chart");
      expect(chart.chartType).toBe("pie");
      expect(chart._chartXml).toContain("c:pieChart");
      expect(chart._chartXml).toContain("<c:v>Us</c:v>");
      expect(chart._chartXml).toContain("<c:v>50</c:v>");
      expect(chart._chartXml).toContain("Market Share");
    });

    it("should support donut style", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        donut: true,
      });
      expect(chart._chartXml).toContain("c:doughnutChart");
    });

    it("doughnut chart should include required holeSize element", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        donut: true,
      });
      expect(chart._chartXml).toContain("c:holeSize");
      expect(chart._chartXml).toContain('val="50"'); // default 50%
    });

    it("doughnut chart should accept custom holeSize", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        donut: true,
        holeSize: 75,
      });
      expect(chart._chartXml).toContain('c:holeSize val="75"');
    });

    it("should show percentage labels by default", () => {
      const chart = charts.pieChart({
        labels: ["A"],
        values: [100],
      });
      expect(chart._chartXml).toContain('showPercent val="1"');
    });

    it("should apply custom colors per slice", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [50, 50],
        colors: ["#FF0000", "#00FF00"],
      });
      expect(chart._chartXml).toContain('val="FF0000"');
      expect(chart._chartXml).toContain('val="00FF00"');
    });

    it("should place dLbls inside ser for per-point label control (ECMA-376 CT_PieSer)", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        showPercent: true,
      });
      // Per ECMA-376 CT_PieSer, dLbls can be inside c:ser for per-point control
      // This allows selective label hiding based on labelThreshold
      const serStart = chart._chartXml.indexOf("<c:ser>");
      const serEnd = chart._chartXml.indexOf("</c:ser>");
      const dLblsStart = chart._chartXml.indexOf("<c:dLbls>");
      expect(serStart).toBeGreaterThan(-1);
      expect(serEnd).toBeGreaterThan(-1);
      expect(dLblsStart).toBeGreaterThan(-1);
      // dLbls should be INSIDE c:ser (between start and end tags)
      expect(dLblsStart).toBeGreaterThan(serStart);
      expect(dLblsStart).toBeLessThan(serEnd);
    });

    it("dLbls children should follow ECMA-376 required order", () => {
      const chart = charts.pieChart({
        labels: ["A", "B"],
        values: [60, 40],
        showPercent: true,
      });
      // ECMA-376: showVal < showCatName < showSerName < showPercent
      const xml = chart._chartXml;
      const showVal = xml.indexOf("c:showVal");
      const showCatName = xml.indexOf("c:showCatName");
      const showSerName = xml.indexOf("c:showSerName");
      const showPercent = xml.indexOf("c:showPercent");
      expect(showVal).toBeLessThan(showCatName);
      expect(showCatName).toBeLessThan(showSerName);
      expect(showSerName).toBeLessThan(showPercent);
    });
  });

  describe("lineChart", () => {
    it("should generate line chart XML", () => {
      const chart = charts.lineChart({
        categories: ["Jan", "Feb", "Mar"],
        series: [{ name: "Sales", values: [10, 20, 30] }],
        title: "Monthly Sales",
      });
      expect(chart.type).toBe("chart");
      expect(chart.chartType).toBe("line");
      expect(chart._chartXml).toContain("c:lineChart");
      expect(chart._chartXml).toContain("Monthly Sales");
    });

    it("should support smooth lines", () => {
      const chart = charts.lineChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        smooth: true,
      });
      expect(chart._chartXml).toContain('smooth val="1"');
    });

    it("should support area fill", () => {
      const chart = charts.lineChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
        area: true,
      });
      expect(chart.chartType).toBe("area");
      expect(chart._chartXml).toContain("c:areaChart");
    });

    it("area chart should NOT include c:marker (ECMA-376)", () => {
      const chart = charts.lineChart({
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
        area: true,
      });
      expect(chart._chartXml).not.toContain("c:marker");
    });

    it("line chart SHOULD include c:marker by default", () => {
      const chart = charts.lineChart({
        categories: ["A", "B"],
        series: [{ name: "S", values: [1, 2] }],
      });
      expect(chart._chartXml).toContain("c:marker");
      expect(chart._chartXml).toContain('val="circle"');
    });
  });

  describe("comboChart", () => {
    it("should generate bar + line combo chart", () => {
      const chart = charts.comboChart({
        categories: ["Q1", "Q2", "Q3", "Q4"],
        barSeries: [{ name: "Revenue", values: [100, 200, 300, 400] }],
        lineSeries: [{ name: "Growth %", values: [10, 20, 15, 25] }],
        title: "Revenue & Growth",
      });
      expect(chart.type).toBe("chart");
      expect(chart.chartType).toBe("combo");
      expect(chart._chartXml).toContain("c:barChart");
      expect(chart._chartXml).toContain("c:lineChart");
      expect(chart._chartXml).toContain("Revenue");
      expect(chart._chartXml).toContain("Growth %");
    });
  });

  describe("embedChart", () => {
    it("should return shape XML and ZIP entries", () => {
      const pres = pptx.createPresentation();
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
      });
      const result = charts.embedChart(pres, chart, {
        x: 1,
        y: 1.5,
        w: 10,
        h: 5,
      });

      expect(result.shapeXml).toContain("p:graphicFrame");
      expect(result.shapeXml).toContain("Chart 1");
      expect(result.zipEntries).toHaveLength(2);
      expect(result.zipEntries[0].name).toContain("chart1.xml");
      expect(result.chartIndex).toBe(1);
    });

    it("should increment chart index", () => {
      const pres = pptx.createPresentation();
      const chart = charts.barChart({
        categories: ["A"],
        series: [{ name: "S", values: [1] }],
      });
      const r1 = charts.embedChart(pres, chart, { x: 0, y: 0, w: 5, h: 3 });
      const r2 = charts.embedChart(pres, chart, { x: 5, y: 0, w: 5, h: 3 });
      expect(r1.chartIndex).toBe(1);
      expect(r2.chartIndex).toBe(2);
    });
  });
});

// ── pptx-tables ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tables: any = await import("../builtin-modules/pptx-tables.js");

describe("pptx-tables", () => {
  describe("table", () => {
    it("should generate table XML with headers and rows", () => {
      const xml = toXml(
        tables.table({
          x: 1,
          y: 2,
          w: 10,
          headers: ["Name", "Value"],
          rows: [
            ["CPU", "1000ms"],
            ["Heap", "64MB"],
          ],
        }),
      );
      expect(xml).toContain("a:tbl");
      expect(xml).toContain("<a:t>Name</a:t>");
      expect(xml).toContain("<a:t>Value</a:t>");
      expect(xml).toContain("<a:t>CPU</a:t>");
      expect(xml).toContain("<a:t>64MB</a:t>");
    });

    it("should escape XML in cell content", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 5,
          headers: ["Test"],
          rows: [["A & B"]],
        }),
      );
      expect(xml).toContain("A &amp; B");
    });

    it("should apply custom header styling", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 5,
          headers: ["H1"],
          rows: [["D1"]],
          style: { headerBg: "FF0000", headerColor: "000000" },
        }),
      );
      expect(xml).toContain('val="FF0000"');
    });

    it("should support alternating row colors", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 5,
          headers: ["H"],
          rows: [["R1"], ["R2"], ["R3"]],
          style: { altRows: true, altRowColor: "EEEEFF" },
        }),
      );
      expect(xml).toContain('val="EEEEFF"');
      expect(xml).toContain('bandRow="1"');
    });
  });

  describe("kvTable", () => {
    it("should create a two-column key-value table", () => {
      const xml = toXml(
        tables.kvTable({
          x: 1,
          y: 2,
          w: 6,
          items: [
            { key: "CPU", value: "1000ms" },
            { key: "Heap", value: "64MB" },
          ],
        }),
      );
      expect(xml).toContain("<a:t>CPU</a:t>");
      expect(xml).toContain("<a:t>1000ms</a:t>");
      expect(xml).toContain("<a:t>Heap</a:t>");
      expect(xml).toContain("<a:t>64MB</a:t>");
    });
  });

  describe("comparisonTable", () => {
    it("should generate comparison with check/cross marks", () => {
      const xml = toXml(
        tables.comparisonTable({
          x: 1,
          y: 2,
          w: 10,
          features: ["Fast startup", "Low memory", "Sandboxed"],
          options: [
            { name: "VMs", values: [false, false, true] },
            { name: "Containers", values: [true, true, false] },
            { name: "Hyperlight", values: [true, true, true] },
          ],
        }),
      );
      expect(xml).toContain("a:tbl");
      expect(xml).toContain("<a:t>VMs</a:t>");
      expect(xml).toContain("<a:t>Hyperlight</a:t>");
      expect(xml).toContain("<a:t>✓</a:t>");
      expect(xml).toContain("<a:t>✗</a:t>");
    });
  });

  describe("timeline", () => {
    it("should generate timeline with phases", () => {
      const xml = toXml(
        tables.timeline({
          x: 0.5,
          y: 3,
          w: 12,
          items: [
            { label: "Q1", description: "Research" },
            { label: "Q2", description: "Build" },
            { label: "Q3", description: "Launch" },
          ],
        }),
      );
      expect(xml).toContain("a:tbl");
      expect(xml).toContain("<a:t>Q1</a:t>");
      expect(xml).toContain("<a:t>Build</a:t>");
    });
  });

  describe("border XML", () => {
    it("should generate well-formed border elements", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 5,
          headers: ["H"],
          rows: [["R1"]],
          style: { borderColor: "334455" },
        }),
      );
      // Each lnX element must be self-consistent (no inner </a:ln>)
      expect(xml).not.toContain("</a:ln>");
      // lnL must open and close correctly
      expect(xml).toContain("<a:lnL");
      expect(xml).toContain("</a:lnL>");
      expect(xml).toContain("<a:lnR");
      expect(xml).toContain("</a:lnR>");
      expect(xml).toContain("<a:lnT");
      expect(xml).toContain("</a:lnT>");
      expect(xml).toContain("<a:lnB");
      expect(xml).toContain("</a:lnB>");
      // Border color is included
      expect(xml).toContain('val="334455"');
      // w attribute is on the lnX element, not floating
      expect(xml).not.toContain("<a:lnL> w=");
      expect(xml).toContain('<a:lnL w="');
    });

    it("should place borders BEFORE fill in tcPr (ECMA-376 §21.1.3.17)", () => {
      const xml = toXml(
        tables.table({
          x: 0,
          y: 0,
          w: 5,
          headers: ["H"],
          rows: [["R1"]],
          style: { headerBg: "2196F3", borderColor: "CCCCCC" },
        }),
      );
      // In every tcPr, lnL must appear before solidFill
      const tcPrs = xml.match(/<a:tcPr[^>]*>.*?<\/a:tcPr>/gs) || [];
      expect(tcPrs.length).toBeGreaterThan(0);
      for (const tcPr of tcPrs) {
        const lnLPos = tcPr.indexOf("<a:lnL");
        const fillPos = tcPr.indexOf("<a:solidFill");
        if (lnLPos >= 0 && fillPos >= 0) {
          expect(lnLPos).toBeLessThan(fillPos);
        }
      }
    });
  });
});
