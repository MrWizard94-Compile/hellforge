/**
 * HellForge council — pure, DOM-free multi-agent comms logic.
 * Mirrors core.js: every function is pure and unit-tested (test/council.test.js).
 */
/* node:coverage disable */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HFCouncil = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* node:coverage enable */
  "use strict";

  /** Map forge kind (claude/grok/ollama/…) to a collaboration role. */
  function roleFor(kind) {
    const k = String(kind == null ? "" : kind).toLowerCase();
    if (k === "claude") return "orchestrator";
    if (k === "grok") return "executor";
    if (k === "ollama") return "local";
    return "shell";
  }

  const ROLE_META = {
    orchestrator: { label: "Orchestrator", icon: "\u{1F702}" },
    executor: { label: "Executor", icon: "⚡" },
    local: { label: "Local", icon: "\u{1F999}" },
    shell: { label: "Shell", icon: "⚒" },
    director: { label: "Director", icon: "\u{1F451}" },
  };

  /** Display label + icon for a collaboration role (falls back to shell). */
  function roleMeta(role) {
    const r = String(role == null ? "" : role).toLowerCase();
    return ROLE_META[r] || ROLE_META.shell;
  }

  /** Build a normalized, deterministic message record.
   *  Optional 5th arg `extra` may include Protocol v2 fields: type, id, ref, path.
   *  Legacy callers (4 args) still produce {ts,from,to,text} only.
   */
  function makeMessage(from, to, text, now, extra) {
    const ts = Number(now) || 0;
    const fromStr = from == null || String(from) === "" ? "?" : String(from);
    const toStr = to == null || String(to) === "" ? "all" : String(to);
    const textStr = text == null ? "" : String(text);
    const msg = { ts: ts, from: fromStr, to: toStr, text: textStr };
    if (extra != null && typeof extra === "object" && !Array.isArray(extra)) {
      if (extra.type != null && String(extra.type) !== "") msg.type = String(extra.type);
      if (extra.id != null && String(extra.id) !== "") msg.id = String(extra.id);
      if (extra.ref != null && String(extra.ref) !== "") msg.ref = String(extra.ref);
      if (extra.path != null && String(extra.path) !== "") msg.path = String(extra.path);
    }
    return msg;
  }

  /** Protocol v2 typed bus message (approve_request, kill, budget, …). */
  function makeProtocolMessage(from, to, text, type, path, now) {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        : Math.random().toString(16).slice(2, 10);
    return makeMessage(from, to, text, now, {
      type: type || "chat",
      id: id,
      path: path || undefined,
    });
  }

  /**
   * Serialize a message to one physical JSONL line. JSON.stringify already
   * escapes any embedded newlines, so the result is always a single line.
   * Non-object input falls back to an empty message so the bus never corrupts.
   */
  function serializeMsg(msg) {
    const payload =
      msg != null && typeof msg === "object" && !Array.isArray(msg)
        ? msg
        : { ts: 0, from: "?", to: "all", text: "" };
    return JSON.stringify(payload);
  }

  /** Parse a JSONL bus dump into message objects (skip blank/garbage lines). */
  function parseBus(text) {
    if (typeof text !== "string" || text === "") return [];
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i]).trim();
      if (!line) continue;
      try {
        const v = JSON.parse(line);
        if (v !== null && typeof v === "object") out.push(v);
      } catch {
        /* skip invalid JSON */
      }
    }
    return out;
  }

  /** Resolve which forge ids a message target addresses. */
  function resolveTargets(target, forges) {
    if (!Array.isArray(forges)) return [];

    const list = [];
    for (let i = 0; i < forges.length; i++) {
      const f = forges[i];
      if (f == null || typeof f !== "object") continue;
      if (f.id == null || f.id === "") continue;
      list.push(f);
    }

    if (target == null || target === "") return list.map((f) => f.id);

    if (typeof target === "object" || typeof target === "function") return [];

    const lower = String(target).toLowerCase();
    if (lower === "all" || lower === "*") return list.map((f) => f.id);

    const byRole = [];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].role).toLowerCase() === lower) byRole.push(list[i].id);
    }
    if (byRole.length > 0) return byRole;

    const asNum = Number(target);
    const isNumeric =
      typeof target === "number"
        ? Number.isFinite(asNum)
        : typeof target === "string" &&
          target.trim() !== "" &&
          Number.isFinite(asNum) &&
          /^-?\d+(\.\d+)?$/.test(String(target).trim());

    if (isNumeric) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === asNum || Number(list[i].id) === asNum) return [list[i].id];
      }
      return [];
    }

    return [];
  }

  /** Turn free text into a single line typed into a PTY (trailing CR). */
  function formatForPty(text) {
    if (text == null) return "";
    const s = String(text).replace(/[\r\n]+$/, "");
    if (s.trim() === "") return "";
    return s + "\r";
  }

  /** Extract @mention tokens, lowercased and de-duplicated in first-seen order. */
  function mentions(text) {
    if (typeof text !== "string" || text === "") return [];
    const re = /@(\w+)/g;
    const seen = Object.create(null);
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = String(m[1]).toLowerCase();
      if (!seen[tok]) {
        seen[tok] = true;
        out.push(tok);
      }
    }
    return out;
  }

  /**
   * Case-insensitive filter of bus messages by text / from / to containing
   * `query`. Empty query returns all valid message objects. Garbage-safe.
   */
  function filterBus(messages, query) {
    if (!Array.isArray(messages)) return [];
    const q = query == null ? "" : String(query).toLowerCase();
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m == null || typeof m !== "object" || Array.isArray(m)) continue;
      if (!q) {
        out.push(m);
        continue;
      }
      const text = String(m.text == null ? "" : m.text).toLowerCase();
      const from = String(m.from == null ? "" : m.from).toLowerCase();
      const to = String(m.to == null ? "" : m.to).toLowerCase();
      if (text.includes(q) || from.includes(q) || to.includes(q)) out.push(m);
    }
    return out;
  }

  /**
   * Markdown transcript of bus messages.
   * Header + one block per message (time / from / to / text). Null-safe.
   */
  function formatBusExport(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const lines = ["# Council Bus Export", ""];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m == null || typeof m !== "object" || Array.isArray(m)) continue;
      const ts = Number(m.ts);
      let timeStr;
      if (Number.isFinite(ts) && ts > 0) {
        try {
          timeStr = new Date(ts).toISOString();
        } catch {
          timeStr = String(m.ts == null ? "" : m.ts);
        }
      } else {
        timeStr = m.ts == null ? "" : String(m.ts);
      }
      const from = m.from == null ? "?" : String(m.from);
      const to = m.to == null ? "all" : String(m.to);
      const text = m.text == null ? "" : String(m.text);
      lines.push("## " + timeStr);
      lines.push("- **from:** " + from);
      lines.push("- **to:** " + to);
      lines.push("");
      lines.push(text);
      lines.push("");
    }
    return lines.join("\n");
  }

  return {
    roleFor,
    roleMeta,
    makeMessage,
    makeProtocolMessage,
    serializeMsg,
    parseBus,
    resolveTargets,
    formatForPty,
    mentions,
    filterBus,
    formatBusExport,
  };
});
