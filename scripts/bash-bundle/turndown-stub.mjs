// Turndown stub for QuickJS — no DOM available, so we implement
// HTML-to-Markdown conversion with regex. Not perfect, but handles
// the common cases (headings, bold, italic, links, lists, paragraphs).
export default class TurndownService {
  constructor() {}
  turndown(html) {
    if (!html || typeof html !== "string") return "";
    let t = html;
    // Remove script, style, nav, footer
    t = t.replace(/<script[\s\S]*?<\/script>/gi, "");
    t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
    t = t.replace(/<nav[\s\S]*?<\/nav>/gi, "");
    t = t.replace(/<footer[\s\S]*?<\/footer>/gi, "");
    t = t.replace(/<!--[\s\S]*?-->/g, "");
    // Headings
    t = t.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => "\n# " + s(c).trim() + "\n\n");
    t = t.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => "\n## " + s(c).trim() + "\n\n");
    t = t.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => "\n### " + s(c).trim() + "\n\n");
    t = t.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => "\n#### " + s(c).trim() + "\n\n");
    t = t.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => "\n##### " + s(c).trim() + "\n\n");
    t = t.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => "\n###### " + s(c).trim() + "\n\n");
    // Bold and italic
    t = t.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
    t = t.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*");
    // Code blocks
    t = t.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, c) => "\n```\n" + s(c).trim() + "\n```\n");
    t = t.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
    // Links
    t = t.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => "[" + s(text).trim() + "](" + href + ")");
    t = t.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (_, c) => s(c));
    // Images
    t = t.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
    t = t.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
    // List items
    t = t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => "- " + s(c).trim() + "\n");
    t = t.replace(/<\/?[ou]l[^>]*>/gi, "\n");
    // Blockquotes
    t = t.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
      return s(c).trim().split("\n").map(l => "> " + l.trim()).join("\n") + "\n\n";
    });
    // Horizontal rules
    t = t.replace(/<hr[^>]*\/?>/gi, "\n---\n\n");
    // Paragraphs and line breaks
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = t.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => "\n" + s(c).trim() + "\n\n");
    // Strip remaining tags
    t = s(t);
    // Decode entities
    t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    t = t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    t = t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    // Clean whitespace
    t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s+$/gm, "").trim();
    return t;
  }
}
function s(html) { return html.replace(/<[^>]+>/g, ""); }
