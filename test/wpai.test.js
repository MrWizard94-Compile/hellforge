/**
 * Spec for renderer/wpai.js — pure WPAI control-plane helpers (HFWpai).
 * No Electron, no DOM — Node unit tests only.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const HFWpai = require("../renderer/wpai.js");
const { formatSnapshotLine, parseFirstPendingId, buildWpaiArgs } = HFWpai;

// ---- formatSnapshotLine ----
test("formatSnapshotLine: null/undefined/garbage → offline", () => {
  assert.equal(formatSnapshotLine(null), "WPAI · offline");
  assert.equal(formatSnapshotLine(undefined), "WPAI · offline");
  assert.equal(formatSnapshotLine("nope"), "WPAI · offline");
  assert.equal(formatSnapshotLine(42), "WPAI · offline");
  assert.equal(formatSnapshotLine([]), "WPAI · offline");
});

test("formatSnapshotLine: ok:false uses error or offline", () => {
  assert.equal(formatSnapshotLine({ ok: false }), "WPAI · offline");
  assert.equal(
    formatSnapshotLine({ ok: false, error: "BLACKBOARD missing" }),
    "WPAI · BLACKBOARD missing",
  );
  const long = "x".repeat(200);
  const line = formatSnapshotLine({ ok: false, error: long });
  assert.ok(line.startsWith("WPAI · "));
  assert.ok(line.length <= "WPAI · ".length + 80);
});

test("formatSnapshotLine: happy path with defaults", () => {
  const line = formatSnapshotLine({
    ok: true,
    pending: 2,
    kill: { loops: true },
    budgets: { api_usd_spent_est_day: 1.2, api_usd_cap_day: 5 },
    overnight: { armed: true },
    music: { checklist_pass: true },
  });
  assert.equal(line, "APPROVALS 2 · KILL ON · $DAY 1.2/5 · NIGHT ARMED · MUSIC READY");
});

test("formatSnapshotLine: missing nested objects default safely", () => {
  const line = formatSnapshotLine({ ok: true });
  assert.equal(line, "APPROVALS 0 · KILL off · $DAY 0/5 · NIGHT idle · MUSIC …");
});

test("formatSnapshotLine: kill flags any of global/loops/research/publishes", () => {
  assert.match(formatSnapshotLine({ ok: true, kill: { global: true } }), /KILL ON/);
  assert.match(formatSnapshotLine({ ok: true, kill: { research: 1 } }), /KILL ON/);
  assert.match(formatSnapshotLine({ ok: true, kill: { publishes: "yes" } }), /KILL ON/);
  assert.match(formatSnapshotLine({ ok: true, kill: {} }), /KILL off/);
});

// ---- parseFirstPendingId ----
test("parseFirstPendingId: finds first appr- id", () => {
  const out =
    "pending:\n  appr-abc123  music release\n  appr-def456  other\n";
  assert.equal(parseFirstPendingId(out), "appr-abc123");
});

test("parseFirstPendingId: case-insensitive hex", () => {
  assert.equal(parseFirstPendingId("id=appr-DEADBEEF ok"), "appr-DEADBEEF");
});

test("parseFirstPendingId: none / garbage → null", () => {
  assert.equal(parseFirstPendingId(""), null);
  assert.equal(parseFirstPendingId("no approvals"), null);
  assert.equal(parseFirstPendingId(null), null);
  assert.equal(parseFirstPendingId(undefined), null);
  assert.equal(parseFirstPendingId(99), null);
  assert.equal(parseFirstPendingId({}), null);
});

// ---- buildWpaiArgs ----
test("buildWpaiArgs: simple deck actions", () => {
  assert.deepEqual(buildWpaiArgs("kill-loops"), ["kill", "set", "loops", "true"]);
  assert.deepEqual(buildWpaiArgs("unkill-loops"), ["kill", "set", "loops", "false"]);
  assert.deepEqual(buildWpaiArgs("music"), ["music", "check"]);
  assert.deepEqual(buildWpaiArgs("music-ticket"), ["music", "check", "-EmitTicket"]);
  assert.deepEqual(buildWpaiArgs("approvals"), ["approve", "list"]);
  assert.deepEqual(buildWpaiArgs("sync"), ["bridge", "sync"]);
});

test("buildWpaiArgs: approve/reject first with list stdout", () => {
  const list = "pending appr-aa11bb\n";
  assert.deepEqual(buildWpaiArgs("approve-first", list), [
    "approve",
    "decide",
    "appr-aa11bb",
    "approved",
  ]);
  assert.deepEqual(buildWpaiArgs("reject-first", list), [
    "approve",
    "decide",
    "appr-aa11bb",
    "rejected",
  ]);
});

test("buildWpaiArgs: approve/reject with no id → null", () => {
  assert.equal(buildWpaiArgs("approve-first", "none"), null);
  assert.equal(buildWpaiArgs("reject-first", ""), null);
  assert.equal(buildWpaiArgs("approve-first"), null);
});

test("buildWpaiArgs: refresh/unknown/garbage → null", () => {
  assert.equal(buildWpaiArgs("refresh"), null);
  assert.equal(buildWpaiArgs("nope"), null);
  assert.equal(buildWpaiArgs(null), null);
  assert.equal(buildWpaiArgs(undefined), null);
  assert.equal(buildWpaiArgs(12), null);
});

// ---- UMD browser attach ----
test("UMD attaches HFWpai when required as script in a sandbox", () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/wpai.js"), "utf8");
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.HFWpai.formatSnapshotLine, "function");
  assert.equal(typeof sandbox.HFWpai.parseFirstPendingId, "function");
  assert.equal(typeof sandbox.HFWpai.buildWpaiArgs, "function");
});
