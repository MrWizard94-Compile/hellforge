/**
 * HellForge core — pure, DOM-free logic.
 *
 * Everything here is a pure function so it can be unit-tested in Node
 * (see test/core.test.js) and reused in the renderer. No `document`,
 * no `window`, no xterm. The renderer (app.js) is the DOM/PTY glue that
 * calls into this.
 *
 * UMD-ish export: attaches to module.exports under Node, and to
 * globalThis.HFCore in the browser (loaded via a plain <script> before app.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HFCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Subsequence fuzzy match with a contiguity bonus.
   * Returns 0 when `q` is not a subsequence of `s`; higher is a better match.
   * An empty query returns 1 (everything matches equally) so the palette
   * shows the full list before typing.
   */
  function fuzzy(q, s) {
    q = String(q).toLowerCase();
    s = String(s).toLowerCase();
    if (!q) return 1;
    let qi = 0,
      score = 0,
      streak = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) {
        qi++;
        streak++;
        score += streak; // reward consecutive matches
      } else {
        streak = 0;
      }
    }
    return qi === q.length ? score + (s.startsWith(q) ? 50 : 0) : 0;
  }

  /**
   * Rank palette items by a query. Each item is scored on its name (full
   * weight) falling back to its sub text (0.3 weight). With no query the
   * original order is preserved. Returns a new array, capped at `limit`.
   */
  function rankItems(items, q, limit) {
    limit = limit == null ? 40 : limit;
    const scored = items
      .map((it) => ({ it, s: fuzzy(q, it.name) || fuzzy(q, it.sub || "") * 0.3 }))
      .filter((x) => x.s > 0 || !q);
    if (q) scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.it);
  }

  /**
   * Which pane ids are visible given the ordered pane list, the focused id,
   * and the layout (1 | 2 | 4). The visible window slides so the focused
   * pane is always included, clamped to the end of the list.
   */
  function visibleIds(order, activeId, layout) {
    if (!order.length) return [];
    if (layout === 1) return activeId != null ? [activeId] : [order[0]];
    const fi = Math.max(0, order.indexOf(activeId));
    const start = Math.min(fi, Math.max(0, order.length - layout));
    return order.slice(start, start + layout);
  }

  /** CSS grid class for a given number of visible panes. */
  function layoutClass(n) {
    return "l" + (n <= 1 ? 1 : n <= 2 ? 2 : 4);
  }

  /**
   * Build the shell + args for spawning a forge, per shell family.
   *
   * PowerShell (pwsh/powershell) is driven with `-Command` so we can inject
   * the themed prompt and any run-command deterministically. cmd.exe uses the
   * documented `/K` to run-then-stay-interactive. Every other shell
   * (WSL, Git Bash, …) is launched plainly and any run-command is returned as
   * `deferredRun` for the caller to type into the PTY once it's ready —
   * because the "run then stay interactive" incantation is shell-specific and
   * not worth guessing.
   *
   * @returns {{args: string[], deferredRun: string|null}}
   */
  function buildShellArgs(shell, opts) {
    opts = opts || {};
    const { isClaude, run, promptCmd } = opts;
    const isPwsh = /pwsh|powershell/i.test(shell);
    if (isPwsh) {
      let cmd = promptCmd || "";
      if (isClaude) cmd += "; claude";
      else if (run) cmd += "; " + run;
      return { args: ["-NoLogo", "-NoExit", "-Command", cmd], deferredRun: null };
    }
    if (/cmd\.exe/i.test(shell)) {
      return { args: run ? ["/K", run] : [], deferredRun: null };
    }
    // WSL / Git Bash / anything else: launch plain, type the command after.
    return { args: [], deferredRun: run || null };
  }

  /** System CPU load (0–100) clamped for the pressure gauge. */
  function gaugeHeight(cpu) {
    return Math.max(4, Math.min(100, Number(cpu) || 0));
  }

  return { fuzzy, rankItems, visibleIds, layoutClass, buildShellArgs, gaugeHeight };
});
