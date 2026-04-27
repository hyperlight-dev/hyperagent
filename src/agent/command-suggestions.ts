/**
 * Suggested Command Extraction
 *
 * Scans LLM response text for actionable slash commands and returns
 * them for user approval. Only configuration-type commands are
 * extracted — never destructive or navigation commands like /exit,
 * /clear, /new, /help, /sessions.
 */

/** Command prefixes that are safe to auto-suggest for approval. */
export const ACTIONABLE_COMMAND_PREFIXES = [
  "/plugin enable",
  "/plugin disable",
  "/mcp enable",
  "/buffer ",
  "/timeout ",
  "/set ",
];

/**
 * Placeholder patterns that indicate a command is illustrative, not
 * a real actionable suggestion.  RFC 2606 reserves example.{com,net,org}
 * and <angle-bracket> placeholders are obviously templated.
 */
const PLACEHOLDER_RE = /example\.(?:com|net|org)|<[^>]+>/i;

/**
 * Scan the assistant's response text for slash commands that match
 * actionable prefixes.  Returns deduplicated commands in order.
 *
 * Detects both inline `` `/command ...` `` backtick-wrapped commands
 * and bare commands on their own line.
 */
export function extractSuggestedCommands(text: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();

  // Pattern 1: commands inside backticks — `/plugin enable fetch ...`
  // This catches inline code references the LLM wraps in backticks.
  const backtickRe =
    /`(\/(?:plugin\s+enable|plugin\s+disable|mcp\s+enable|buffer|timeout|set)\s[^`]+)`/gi;
  for (const m of text.matchAll(backtickRe)) {
    const cmd = m[1].trim();
    if (!seen.has(cmd) && !PLACEHOLDER_RE.test(cmd)) {
      seen.add(cmd);
      commands.push(cmd);
    }
  }

  // Pattern 2: bare commands as the start of a line (possibly indented).
  // Only matched if not already found via backtick pattern.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("/") &&
      ACTIONABLE_COMMAND_PREFIXES.some((p) =>
        trimmed.toLowerCase().startsWith(p.toLowerCase()),
      )
    ) {
      // Strip any trailing markdown/punctuation the LLM might append
      const cleaned = trimmed.replace(/[`*_]+$/g, "").trim();
      if (cleaned && !seen.has(cleaned) && !PLACEHOLDER_RE.test(cleaned)) {
        seen.add(cleaned);
        commands.push(cleaned);
      }
    }
  }

  return commands;
}
