/**
 * HellForge WPAI — pure, DOM-free control-plane helpers.
 *
 * Snapshot formatting, approve-list parsing, and wpai.ps1 arg building.
 * No `document`, no Electron, no filesystem. Unit-tested in test/wpai.test.js.
 *
 * UMD-ish: module.exports under Node, globalThis.HFWpai in the browser
 * (loaded via <script> before app.js).
 */
/* node:coverage disable */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HFWpai = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* node:coverage enable */
  "use strict";

  /**
   * Short human-readable status line from a wpai:snapshot result.
   * Garbage-safe: null/undefined/non-objects and failed snaps produce offline text.
   */
  function formatSnapshotLine(snap) {
    if (snap == null || typeof snap !== "object" || Array.isArray(snap)) {
      return "WPAI · offline";
    }
    if (!snap.ok) {
      const err =
        snap.error != null && String(snap.error) !== ""
          ? String(snap.error).slice(0, 80)
          : "offline";
      return "WPAI · " + err;
    }
    const k = snap.kill != null && typeof snap.kill === "object" ? snap.kill : {};
    const b = snap.budgets != null && typeof snap.budgets === "object" ? snap.budgets : {};
    const o = snap.overnight != null && typeof snap.overnight === "object" ? snap.overnight : {};
    const m = snap.music != null && typeof snap.music === "object" ? snap.music : {};
    const killOn = !!(k.global || k.loops || k.research || k.publishes);
    const pending = Number(snap.pending);
    const spent = b.api_usd_spent_est_day != null ? b.api_usd_spent_est_day : 0;
    const cap = b.api_usd_cap_day != null ? b.api_usd_cap_day : 5;
    return (
      "APPROVALS " +
      (Number.isFinite(pending) ? pending : 0) +
      " · KILL " +
      (killOn ? "ON" : "off") +
      " · $DAY " +
      spent +
      "/" +
      cap +
      " · NIGHT " +
      (o.armed ? "ARMED" : "idle") +
      " · MUSIC " +
      (m.checklist_pass ? "READY" : "…")
    );
  }

  /**
   * Extract the first approval id (appr-xxx) from `wpai approve list` stdout.
   * Returns null when none found or input is not a string.
   */
  function parseFirstPendingId(approveListStdout) {
    if (typeof approveListStdout !== "string" || approveListStdout === "") return null;
    const m = approveListStdout.match(/appr-[a-f0-9]+/i);
    return m ? m[0] : null;
  }

  /**
   * Build argv for wpai.ps1 from a deck action name.
   * For approve-first / reject-first, pass approve-list stdout as the second arg.
   * Returns null for unknown actions, refresh (UI-only), or missing approval id.
   */
  function buildWpaiArgs(action, approveListStdout) {
    const act = action == null ? "" : String(action);
    if (act === "kill-loops") return ["kill", "set", "loops", "true"];
    if (act === "unkill-loops") return ["kill", "set", "loops", "false"];
    if (act === "music") return ["music", "check"];
    if (act === "music-ticket") return ["music", "check", "-EmitTicket"];
    if (act === "approvals") return ["approve", "list"];
    if (act === "sync") return ["bridge", "sync"];
    if (act === "approve-first" || act === "reject-first") {
      const id = parseFirstPendingId(approveListStdout);
      if (!id) return null;
      const decision = act === "approve-first" ? "approved" : "rejected";
      return ["approve", "decide", id, decision];
    }
    // refresh is UI-only; unknown actions yield null
    return null;
  }

  return {
    formatSnapshotLine,
    parseFirstPendingId,
    buildWpaiArgs,
  };
});
