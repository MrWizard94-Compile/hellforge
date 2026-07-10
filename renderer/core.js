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
// UMD boilerplate — the export/root branches are environment-dependent and
// can't both run under Node's require; the browser path is proven by the vm
// test in core.test.js, so coverage is disabled for the wrapper only.
/* node:coverage disable */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HFCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* node:coverage enable */
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
    const list = Array.isArray(items) ? items : [];
    const scored = list
      .filter((it) => it != null)
      .map((it) => ({ it, s: fuzzy(q, it.name) || fuzzy(q, it.sub || "") * 0.3 }))
      .filter((x) => x.s > 0 || !q);
    if (q) scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, Math.max(0, limit)).map((x) => x.it);
  }

  /**
   * Which pane ids are visible given the ordered pane list, the focused id,
   * and the layout (1 | 2 | 4). The visible window slides so the focused
   * pane is always included, clamped to the end of the list.
   */
  function visibleIds(order, activeId, layout) {
    if (!Array.isArray(order) || !order.length) return [];
    const n = layout === 2 || layout === 4 ? layout : 1;
    if (n === 1)
      return activeId != null && order.indexOf(activeId) !== -1 ? [activeId] : [order[0]];
    const fi = Math.max(0, order.indexOf(activeId));
    const start = Math.min(fi, Math.max(0, order.length - n));
    return order.slice(start, start + n);
  }

  /** CSS grid class for a given number of visible panes. */
  function layoutClass(n) {
    n = Number(n) || 1;
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
   * `opts.launch` is an interactive agent command (Claude, Grok, `ollama run
   * …`) that should start *after* the themed prompt and keep the session
   * alive; it takes precedence over `opts.run` (a one-shot command). `isClaude`
   * is retained as sugar for `launch: "claude"`.
   *
   * @returns {{args: string[], deferredRun: string|null}}
   */
  function buildShellArgs(shell, opts) {
    opts = opts || {};
    shell = String(shell || "");
    const { isClaude, run, promptCmd } = opts;
    const launch = opts.launch || (isClaude ? "claude" : "");
    const isPwsh = /pwsh|powershell/i.test(shell);
    if (isPwsh) {
      let cmd = promptCmd || "";
      if (launch) cmd += "; " + launch;
      else if (run) cmd += "; " + run;
      return { args: ["-NoLogo", "-NoExit", "-Command", cmd], deferredRun: null };
    }
    if (/cmd\.exe/i.test(shell)) {
      const one = launch || run;
      return { args: one ? ["/K", one] : [], deferredRun: null };
    }
    // WSL / Git Bash / anything else: launch plain, type the command after.
    return { args: [], deferredRun: launch || run || null };
  }

  /** System CPU load (0–100) clamped for the pressure gauge. */
  function gaugeHeight(cpu) {
    return Math.max(4, Math.min(100, Number(cpu) || 0));
  }

  /**
   * Merge persisted settings over defaults. `savedJson` is the raw
   * localStorage string (or null); malformed JSON falls back to defaults.
   * Unknown keys in saved data are preserved; missing keys take the default.
   */
  function mergeSettings(defaults, savedJson) {
    let saved;
    try {
      saved = savedJson ? JSON.parse(savedJson) : {};
    } catch {
      saved = {};
    }
    if (saved == null || typeof saved !== "object") saved = {};
    return Object.assign({}, defaults, saved);
  }

  /**
   * "Sacrifice complete" decision: a forge that was busy (BUSY_MIN_MS of
   * output) and has since gone quiet (IDLE_MS with no output) is considered
   * finished. Pure given the forge's activity timestamps and `now`.
   */
  const BUSY_MIN_MS = 2500;
  const IDLE_MS = 1400;
  function commandFinished(forge, now) {
    if (!forge || !forge.busy) return false;
    const idle = now - (forge.lastData || 0);
    if (idle <= IDLE_MS) return false;
    const dur = (forge.lastData || 0) - (forge.busyStart || 0);
    return dur > BUSY_MIN_MS;
  }

  /**
   * Whether a finished forge should raise a notification: only when the user
   * isn't already watching it (window hidden, or it isn't the focused +
   * visible pane).
   */
  function shouldNotify(id, activeId, visible, hidden) {
    const vis = Array.isArray(visible) ? visible : [];
    const watching = !hidden && activeId === id && vis.indexOf(id) !== -1;
    return !watching;
  }

  /** PTY ids that an input event should be written to (broadcast fans out). */
  function broadcastTargets(broadcast, id, visible) {
    const vis = Array.isArray(visible) ? visible : [];
    return broadcast && vis.indexOf(id) !== -1 ? vis.slice() : [id];
  }

  /** Id to focus after closing the pane at `closedIndex` (order already spliced). */
  function nextActiveAfterClose(order, closedIndex) {
    if (!Array.isArray(order) || !order.length) return null;
    const i = Math.max(0, Math.min(Number(closedIndex) || 0, order.length - 1));
    return order[i];
  }

  /**
   * Format app-uptime seconds as a compact "Xh Ym" / "Ym" string.
   */
  function fmtUptime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    if (!s) return "0m";
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  /**
   * Parse `git status --porcelain=2 --branch` output into a summary.
   * Robust to empty/garbage input. `dirty` counts changed/untracked entries.
   */
  function parseGitStatus(stdout) {
    let branch = "",
      ahead = 0,
      behind = 0,
      dirty = 0;
    for (const line of String(stdout == null ? "" : stdout).split("\n")) {
      if (line.startsWith("# branch.head")) {
        branch = line.slice(14).trim();
      } else if (line.startsWith("# branch.ab")) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          ahead = +m[1];
          behind = +m[2];
        }
      } else if (line && line[0] !== "#") {
        dirty++;
      }
    }
    return { branch, ahead, behind, dirty };
  }

  /**
   * Strip path separators and illegal Windows filename characters.
   * Falls back to "forge" when the result would be empty.
   */
  function sanitizeFilename(name) {
    let s = String(name == null ? "" : name);
    // Path separators + Windows-illegal: < > : " / \ | ? * and ASCII controls
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const c = s.charCodeAt(i);
      if (c < 32) continue;
      if ('<>:"/\\|?*'.indexOf(ch) !== -1) continue;
      out += ch;
    }
    s = out.replace(/^\.+/, "").trim();
    return s || "forge";
  }

  /** Zero-pad a number to two digits (local-time journal stamps). */
  function _pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /**
   * Build a journal filename: `journal-YYYYMMDD-HHMMSS-<sanitized-label>.md`
   * using the local timezone of `nowMs`.
   */
  function journalFilename(label, nowMs) {
    const d = new Date(Number(nowMs) || 0);
    const y = d.getFullYear();
    const mo = _pad2(d.getMonth() + 1);
    const day = _pad2(d.getDate());
    const h = _pad2(d.getHours());
    const mi = _pad2(d.getMinutes());
    const s = _pad2(d.getSeconds());
    const stamp = "" + y + mo + day + "-" + h + mi + s;
    return "journal-" + stamp + "-" + sanitizeFilename(label) + ".md";
  }

  /**
   * Markdown journal body with a YAML-ish front-matter header.
   * All fields are string-coerced; null/undefined become empty strings.
   */
  function journalMarkdown(opts) {
    const o = opts != null && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    const str = (v) => (v == null ? "" : String(v));
    const title = str(o.title);
    const kind = str(o.kind);
    const cwd = str(o.cwd);
    const savedAt = str(o.savedAt);
    const body = str(o.body);
    return (
      "---\n" +
      "title: " +
      title +
      "\n" +
      "kind: " +
      kind +
      "\n" +
      "cwd: " +
      cwd +
      "\n" +
      "savedAt: " +
      savedAt +
      "\n" +
      "---\n\n" +
      body
    );
  }

  /**
   * Normalize pin storage (JSON string or array) into unique non-empty path
   * strings, capped at 40. Garbage-safe.
   */
  function normalizePins(raw) {
    let list = raw;
    if (typeof raw === "string") {
      try {
        list = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(list)) return [];
    const seen = Object.create(null);
    const out = [];
    for (let i = 0; i < list.length && out.length < 40; i++) {
      const p = list[i];
      if (p == null) continue;
      const s = String(p).trim();
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  /** True when `path` is present in the pin list (string-coerced). */
  function isPinned(pins, path) {
    if (path == null) return false;
    const p = String(path).trim();
    if (!p) return false;
    const list = Array.isArray(pins) ? pins : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] != null && String(list[i]).trim() === p) return true;
    }
    return false;
  }

  /**
   * Return a new pin array with `path` added (if absent) or removed (if
   * present). Empty path is a no-op. Result is re-normalized (unique, max 40).
   */
  function togglePin(pins, path) {
    if (path == null || String(path).trim() === "") {
      return normalizePins(pins);
    }
    const p = String(path).trim();
    const list = normalizePins(pins);
    if (isPinned(list, p)) {
      return list.filter((x) => String(x).trim() !== p);
    }
    if (list.length >= 40) return list.slice();
    return list.concat([p]);
  }

  /**
   * Like rankItems, but pinned projects (kind === "project" and path in
   * pinPaths) receive a +1000 score boost so they sort first on ties / empty
   * query. Returns a new array capped at `limit`.
   */
  function rankItemsWithPins(items, q, limit, pinPaths) {
    limit = limit == null ? 40 : limit;
    const list = Array.isArray(items) ? items : [];
    const pins = Array.isArray(pinPaths) ? pinPaths : [];
    const pinSet = Object.create(null);
    for (let i = 0; i < pins.length; i++) {
      if (pins[i] != null && String(pins[i]) !== "") pinSet[String(pins[i])] = true;
    }
    const scored = list
      .filter((it) => it != null)
      .map((it) => {
        const base = fuzzy(q, it.name) || fuzzy(q, it.sub || "") * 0.3;
        const pinned =
          it.kind === "project" && it.path != null && pinSet[String(it.path)];
        // Boost only contributes to ranking; membership still follows rankItems
        // (empty query keeps all; non-empty requires a positive base match).
        const s = base + (pinned ? 1000 : 0);
        return { it, s, base };
      })
      .filter((x) => x.base > 0 || !q);
    // Always sort so pin boost reorders; equal scores keep stable relative order.
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, Math.max(0, limit)).map((x) => x.it);
  }

  /**
   * Move the id at `fromIndex` to `toIndex` in a tab order array.
   * Returns a new array; bad/out-of-range indices yield a shallow copy of order.
   */
  function reorderTabs(order, fromIndex, toIndex) {
    if (!Array.isArray(order)) return [];
    const out = order.slice();
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return out;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= out.length ||
      toIndex >= out.length
    ) {
      return out;
    }
    if (fromIndex === toIndex) return out;
    const item = out.splice(fromIndex, 1)[0];
    out.splice(toIndex, 0, item);
    return out;
  }

  /**
   * CSS role class for a forge kind tab.
   * claude → role-orchestrator, grok → role-executor, ollama → role-local,
   * everything else → role-shell.
   */
  function roleTabClass(kind) {
    const k = String(kind == null ? "" : kind).toLowerCase();
    if (k === "claude") return "role-orchestrator";
    if (k === "grok") return "role-executor";
    if (k === "ollama") return "role-local";
    return "role-shell";
  }

  return {
    fuzzy,
    rankItems,
    rankItemsWithPins,
    visibleIds,
    layoutClass,
    buildShellArgs,
    gaugeHeight,
    mergeSettings,
    commandFinished,
    shouldNotify,
    broadcastTargets,
    nextActiveAfterClose,
    fmtUptime,
    parseGitStatus,
    sanitizeFilename,
    journalFilename,
    journalMarkdown,
    normalizePins,
    togglePin,
    isPinned,
    reorderTabs,
    roleTabClass,
    BUSY_MIN_MS,
    IDLE_MS,
  };
});
