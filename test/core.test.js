"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fuzzy,
  rankItems,
  visibleIds,
  layoutClass,
  buildShellArgs,
  gaugeHeight,
  mergeSettings,
  commandFinished,
  shouldNotify,
  broadcastTargets,
  nextActiveAfterClose,
  BUSY_MIN_MS,
  IDLE_MS,
} = require("../renderer/core.js");

test("fuzzy: empty query matches everything with score 1", () => {
  assert.equal(fuzzy("", "anything"), 1);
});

test("fuzzy: subsequence matches, non-subsequence scores 0", () => {
  assert.ok(fuzzy("mus", "Music") > 0);
  assert.ok(fuzzy("jns", "Janus") > 0);
  assert.equal(fuzzy("xyz", "Music"), 0);
});

test("fuzzy: prefix match beats scattered match", () => {
  assert.ok(fuzzy("git", "Git status") > fuzzy("git", "Topological gizmo it"));
});

test("fuzzy: contiguous run scores higher than gapped", () => {
  assert.ok(fuzzy("abc", "abc") > fuzzy("abc", "axbxc"));
});

test("fuzzy: case-insensitive", () => {
  assert.ok(fuzzy("JAN", "janus") > 0);
});

test("rankItems: no query preserves order and caps to limit", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: "item" + i }));
  const out = rankItems(items, "", 40);
  assert.equal(out.length, 40);
  assert.equal(out[0].name, "item0");
});

test("rankItems: query surfaces best name match first", () => {
  const items = [
    { name: "Topological Engine", sub: "project" },
    { name: "Git status", sub: "spell · git status" },
    { name: "Janus", sub: "project" },
  ];
  const out = rankItems(items, "git", 10);
  assert.equal(out[0].name, "Git status");
});

test("rankItems: falls back to sub text at reduced weight", () => {
  const items = [{ name: "Clear", sub: "spell · git status" }];
  const out = rankItems(items, "git", 10);
  assert.equal(out.length, 1); // matched via sub, not name
});

test("visibleIds: empty list", () => {
  assert.deepEqual(visibleIds([], null, 1), []);
});

test("visibleIds: single layout shows the focused pane", () => {
  assert.deepEqual(visibleIds([1, 2, 3], 2, 1), [2]);
});

test("visibleIds: single layout with no focus shows first", () => {
  assert.deepEqual(visibleIds([7, 8, 9], null, 1), [7]);
});

test("visibleIds: 2-up window includes the focused pane", () => {
  assert.deepEqual(visibleIds([1, 2, 3, 4], 1, 2), [1, 2]);
  assert.deepEqual(visibleIds([1, 2, 3, 4], 4, 2), [3, 4]); // clamps to end
});

test("visibleIds: 4-grid clamps to available panes", () => {
  assert.deepEqual(visibleIds([1, 2], 1, 4), [1, 2]);
  assert.deepEqual(visibleIds([1, 2, 3, 4, 5], 5, 4), [2, 3, 4, 5]);
});

test("layoutClass maps counts to grid classes", () => {
  assert.equal(layoutClass(1), "l1");
  assert.equal(layoutClass(2), "l2");
  assert.equal(layoutClass(3), "l4");
  assert.equal(layoutClass(4), "l4");
});

test("buildShellArgs: pwsh injects prompt and run", () => {
  const r = buildShellArgs("pwsh.exe", { promptCmd: "P", run: "git status" });
  assert.deepEqual(r.args, ["-NoLogo", "-NoExit", "-Command", "P; git status"]);
  assert.equal(r.deferredRun, null);
});

test("buildShellArgs: pwsh claude appends claude, ignores run", () => {
  const r = buildShellArgs("powershell.exe", { promptCmd: "P", isClaude: true, run: "x" });
  assert.deepEqual(r.args, ["-NoLogo", "-NoExit", "-Command", "P; claude"]);
});

test("buildShellArgs: cmd uses /K for run, empty otherwise", () => {
  assert.deepEqual(buildShellArgs("cmd.exe", { run: "dir" }).args, ["/K", "dir"]);
  assert.deepEqual(buildShellArgs("cmd.exe", {}).args, []);
});

test("buildShellArgs: wsl/bash launch plain and defer the run", () => {
  const wsl = buildShellArgs("wsl.exe", { run: "ls" });
  assert.deepEqual(wsl.args, []);
  assert.equal(wsl.deferredRun, "ls");
  const bash = buildShellArgs("bash.exe", {});
  assert.deepEqual(bash.args, []);
  assert.equal(bash.deferredRun, null);
});

test("gaugeHeight clamps to 4..100", () => {
  assert.equal(gaugeHeight(0), 4);
  assert.equal(gaugeHeight(50), 50);
  assert.equal(gaugeHeight(250), 100);
  assert.equal(gaugeHeight(NaN), 4);
});

test("mergeSettings: defaults fill missing, saved overrides", () => {
  const d = { shell: "pwsh.exe", fontSize: 14.5, glass: 50, sound: true };
  assert.deepEqual(mergeSettings(d, null), d);
  assert.equal(mergeSettings(d, '{"fontSize":18}').fontSize, 18);
  assert.equal(mergeSettings(d, '{"fontSize":18}').shell, "pwsh.exe");
});

test("mergeSettings: malformed JSON falls back to defaults", () => {
  const d = { a: 1 };
  assert.deepEqual(mergeSettings(d, "{not json"), d);
  assert.deepEqual(mergeSettings(d, "null"), d);
  assert.deepEqual(mergeSettings(d, "42"), d);
});

test("commandFinished: busy then idle past thresholds is finished", () => {
  const now = 100000;
  const f = { busy: true, busyStart: now - 5000, lastData: now - IDLE_MS - 100 };
  assert.equal(commandFinished(f, now), true);
});

test("commandFinished: not finished while still receiving output", () => {
  const now = 100000;
  const f = { busy: true, busyStart: now - 5000, lastData: now - 200 };
  assert.equal(commandFinished(f, now), false);
});

test("commandFinished: short commands don't notify", () => {
  const now = 100000;
  const f = { busy: true, busyStart: now - 1000, lastData: now - IDLE_MS - 100 };
  assert.equal(commandFinished(f, now), false); // ran < BUSY_MIN_MS
});

test("commandFinished: not-busy forge is never finished", () => {
  assert.equal(commandFinished({ busy: false }, 1), false);
  assert.equal(commandFinished(null, 1), false);
});

test("shouldNotify: suppressed only when watching the focused visible pane", () => {
  assert.equal(shouldNotify(2, 2, [1, 2], false), false); // watching → no notify
  assert.equal(shouldNotify(2, 2, [1, 2], true), true); // window hidden → notify
  assert.equal(shouldNotify(2, 1, [1, 2], false), true); // focused elsewhere → notify
  assert.equal(shouldNotify(2, 2, [1, 3], false), true); // not visible → notify
});

test("broadcastTargets: off → self, on+visible → all visible, on+hidden → self", () => {
  assert.deepEqual(broadcastTargets(false, 2, [1, 2, 3]), [2]);
  assert.deepEqual(broadcastTargets(true, 2, [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(broadcastTargets(true, 9, [1, 2, 3]), [9]);
});

test("nextActiveAfterClose: picks neighbor, clamps, null when empty", () => {
  assert.equal(nextActiveAfterClose([10, 20, 30], 1), 20);
  assert.equal(nextActiveAfterClose([10, 20], 5), 20); // clamps to last
  assert.equal(nextActiveAfterClose([], 0), null);
});

test("threshold constants are sane", () => {
  assert.ok(BUSY_MIN_MS > IDLE_MS);
});
