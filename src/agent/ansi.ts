// ── ANSI Colours & Helpers ───────────────────────────────────────────
//
// Shared ANSI escape code constants and styled output wrappers.
// Every terminal-coloured string in the agent flows through here.
//
// ─────────────────────────────────────────────────────────────────────

/** Raw ANSI escape sequences — use C.* helpers for styled output. */
export const ANSI = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  cyan: "\x1b[0;36m",
  magenta: "\x1b[0;35m",
  blue: "\x1b[0;34m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reset: "\x1b[0m",
} as const;

// ── Colour Helpers ───────────────────────────────────────────────────
// Shorthand functions for consistent ANSI-coloured terminal output.
//
// Usage:  console.log(`  ${C.ok('✅ Result:')} ${C.val(value)}`);

/** Styled output wrappers — each wraps text in ANSI colour + reset. */
export const C = {
  /** Green — success, enabled, positive outcomes. */
  ok: (s: string) => `${ANSI.green}${s}${ANSI.reset}`,
  /** Red — errors, failures, disabled states. */
  err: (s: string) => `${ANSI.red}${s}${ANSI.reset}`,
  /** Yellow — warnings, caution, degraded states. */
  warn: (s: string) => `${ANSI.yellow}${s}${ANSI.reset}`,
  /** Cyan — informational, values, identifiers. */
  info: (s: string) => `${ANSI.cyan}${s}${ANSI.reset}`,
  /** Bold — labels, headers, emphasis. */
  label: (s: string) => `${ANSI.bold}${s}${ANSI.reset}`,
  /** Cyan — configuration values, paths, model names. */
  val: (s: string) => `${ANSI.cyan}${s}${ANSI.reset}`,
  /** Dim — secondary info, de-emphasised text. */
  dim: (s: string) => `${ANSI.dim}${s}${ANSI.reset}`,
  /** Magenta — tool activity, plugin names. */
  tool: (s: string) => `${ANSI.magenta}${s}${ANSI.reset}`,
  /** Green "ON" / Red "OFF" — for toggle confirmations. */
  onOff: (on: boolean) =>
    on ? `${ANSI.green}ON${ANSI.reset}` : `${ANSI.red}OFF${ANSI.reset}`,
  /** Dim italic — model reasoning text (ephemeral inner monologue). */
  reasoning: (s: string) => `${ANSI.dim}${ANSI.italic}${s}${ANSI.reset}`,
  /**
   * OSC 8 terminal hyperlink — makes `label` clickable, opening `uri`.
   * Falls back to plain underlined cyan text if the terminal doesn't
   * support OSC 8 (the escape is harmless in those terminals).
   *
   * Usage: C.link('https://example.com', 'click here')
   */
  link: (uri: string, label?: string) =>
    `\x1b]8;;${uri}\x07${ANSI.underline}${ANSI.cyan}${label ?? uri}${ANSI.reset}\x1b]8;;\x07`,
  /**
   * Format a file path for terminal output.
   * Outputs the raw absolute path with NO ANSI styling so that
   * terminal emulators (VS Code, Windows Terminal, iTerm2) can
   * auto-detect it and make it ctrl-clickable natively.
   * Adding ANSI escapes breaks the terminal's path detection regex.
   */
  fileLink: (absPath: string, _label?: string) => absPath,
} as const;
