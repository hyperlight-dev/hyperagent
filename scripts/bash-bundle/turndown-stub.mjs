// Stub for turndown (html-to-markdown) — not needed in sandbox
export default class TurndownService {
  constructor() {}
  turndown(html) { return html.replace(/<[^>]+>/g, ''); }
}
