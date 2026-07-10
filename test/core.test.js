"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const HFCore = require("../renderer/core.js");
const {
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
} = HFCore;

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
test("visibleIds: stale/absent focus falls back to first pane", () => {
  assert.deepEqual(visibleIds([1, 2, 3], 99, 1), [1]); // 99 not in order
  assert.deepEqual(visibleIds([1, 2, 3], 99, 3), [1]); // layout 3 clamps to single
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
test("buildShellArgs: pwsh with neither claude nor run is just the prompt", () => {
  assert.deepEqual(buildShellArgs("pwsh.exe", { promptCmd: "P" }).args, [
    "-NoLogo",
    "-NoExit",
    "-Command",
    "P",
  ]);
  // no opts at all
  assert.deepEqual(buildShellArgs("pwsh.exe").args, ["-NoLogo", "-NoExit", "-Command", ""]);
});

test("buildShellArgs: pwsh claude appends claude, ignores run", () => {
  const r = buildShellArgs("powershell.exe", { promptCmd: "P", isClaude: true, run: "x" });
  assert.deepEqual(r.args, ["-NoLogo", "-NoExit", "-Command", "P; claude"]);
});

test("buildShellArgs: pwsh launch (grok/ollama) appends after prompt, wins over run", () => {
  const grok = buildShellArgs("pwsh.exe", { promptCmd: "P", launch: "grok", run: "x" });
  assert.deepEqual(grok.args, ["-NoLogo", "-NoExit", "-Command", "P; grok"]);
  const oll = buildShellArgs("pwsh.exe", {
    promptCmd: "P",
    launch: "docker exec -it ollama-engine ollama run qwen2.5-coder:14b",
  });
  assert.deepEqual(oll.args, [
    "-NoLogo",
    "-NoExit",
    "-Command",
    "P; docker exec -it ollama-engine ollama run qwen2.5-coder:14b",
  ]);
});

test("buildShellArgs: cmd uses /K for run, empty otherwise", () => {
  assert.deepEqual(buildShellArgs("cmd.exe", { run: "dir" }).args, ["/K", "dir"]);
  assert.deepEqual(buildShellArgs("cmd.exe", {}).args, []);
});

test("buildShellArgs: cmd /K uses launch over run", () => {
  assert.deepEqual(buildShellArgs("cmd.exe", { launch: "grok", run: "dir" }).args, ["/K", "grok"]);
  assert.deepEqual(buildShellArgs("cmd.exe", { isClaude: true }).args, ["/K", "claude"]);
});

test("buildShellArgs: wsl/bash launch plain and defer the run", () => {
  const wsl = buildShellArgs("wsl.exe", { run: "ls" });
  assert.deepEqual(wsl.args, []);
  assert.equal(wsl.deferredRun, "ls");
  const bash = buildShellArgs("bash.exe", {});
  assert.deepEqual(bash.args, []);
  assert.equal(bash.deferredRun, null);
});

test("buildShellArgs: wsl/bash defer launch over run", () => {
  const wsl = buildShellArgs("wsl.exe", { launch: "grok", run: "ls" });
  assert.deepEqual(wsl.args, []);
  assert.equal(wsl.deferredRun, "grok");
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
test("commandFinished: busy forge missing timestamps uses 0 fallbacks", () => {
  // busy but no lastData/busyStart -> idle huge, dur 0 -> not finished
  assert.equal(commandFinished({ busy: true }, 5000), false);
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

// ---------- fmtUptime ----------
test("fmtUptime formats seconds compactly", () => {
  assert.equal(fmtUptime(0), "0m");
  assert.equal(fmtUptime(59), "0m");
  assert.equal(fmtUptime(60), "1m");
  assert.equal(fmtUptime(3599), "59m");
  assert.equal(fmtUptime(3600), "1h 0m");
  assert.equal(fmtUptime(3660), "1h 1m");
  assert.equal(fmtUptime(90000), "25h 0m");
});
test("fmtUptime tolerates junk", () => {
  assert.equal(fmtUptime(undefined), "0m");
  assert.equal(fmtUptime(null), "0m");
  assert.equal(fmtUptime(-500), "0m");
  assert.equal(fmtUptime("7200"), "2h 0m");
  assert.equal(fmtUptime(NaN), "0m");
});

// ---------- parseGitStatus ----------
test("parseGitStatus reads branch, ahead/behind, dirty count", () => {
  const out =
    "# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n" +
    "1 .M N... 100644 100644 100644 a b file.txt\n? untracked.txt\n";
  assert.deepEqual(parseGitStatus(out), { branch: "main", ahead: 2, behind: 1, dirty: 2 });
});
test("parseGitStatus: clean repo", () => {
  assert.deepEqual(parseGitStatus("# branch.head main\n# branch.ab +0 -0\n"), {
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: 0,
  });
});
test("parseGitStatus: detached head, no upstream", () => {
  const r = parseGitStatus("# branch.head (detached)\n1 .M x\n");
  assert.equal(r.branch, "(detached)");
  assert.equal(r.dirty, 1);
  assert.equal(r.ahead, 0);
});
test("parseGitStatus: malformed branch.ab line is ignored", () => {
  const r = parseGitStatus("# branch.head main\n# branch.ab garbage here\n");
  assert.equal(r.branch, "main");
  assert.equal(r.ahead, 0);
  assert.equal(r.behind, 0);
});
test("parseGitStatus tolerates empty/garbage/null", () => {
  assert.deepEqual(parseGitStatus(""), { branch: "", ahead: 0, behind: 0, dirty: 0 });
  assert.deepEqual(parseGitStatus(null), { branch: "", ahead: 0, behind: 0, dirty: 0 });
  assert.deepEqual(parseGitStatus(undefined), { branch: "", ahead: 0, behind: 0, dirty: 0 });
  const g = parseGitStatus("total nonsense\nmore junk\n");
  assert.equal(g.dirty, 2); // non-# lines count as changes
});

// ---------- sanitizeFilename ----------
test("sanitizeFilename strips path separators and illegal Windows chars", () => {
  assert.equal(sanitizeFilename('foo/bar\\baz:qux*<>?"|'), "foobarbazqux");
  assert.equal(sanitizeFilename("normal-name_1"), "normal-name_1");
  assert.equal(sanitizeFilename("  spaced  "), "spaced");
});
test("sanitizeFilename falls back to forge when empty after strip", () => {
  assert.equal(sanitizeFilename(""), "forge");
  assert.equal(sanitizeFilename(null), "forge");
  assert.equal(sanitizeFilename(undefined), "forge");
  assert.equal(sanitizeFilename("///"), "forge");
  assert.equal(sanitizeFilename(":::"), "forge");
  assert.equal(sanitizeFilename("..."), "forge");
  assert.equal(sanitizeFilename(42), "42");
});

// ---------- journalFilename ----------
test("journalFilename builds local-time stamp + sanitized label", () => {
  // Construct a known local Date so the stamp is deterministic in this TZ.
  const d = new Date(2024, 0, 5, 9, 7, 3); // local Jan 5 2024 09:07:03
  const name = journalFilename("My Project", d.getTime());
  assert.match(name, /^journal-\d{8}-\d{6}-My Project\.md$/);
  assert.equal(name, "journal-20240105-090703-My Project.md");
});
test("journalFilename sanitizes label and tolerates bad time", () => {
  const name = journalFilename("a/b:c", null);
  assert.ok(name.startsWith("journal-"));
  assert.ok(name.endsWith("-abc.md"));
  assert.equal(journalFilename("", 0).endsWith("-forge.md"), true);
});

// ---------- journalMarkdown ----------
test("journalMarkdown emits YAML-ish header + body", () => {
  const md = journalMarkdown({
    title: "Session",
    kind: "claude",
    cwd: "C:\\WPAI",
    savedAt: "2024-01-05T09:07:03",
    body: "hello\nworld",
  });
  assert.ok(md.startsWith("---\n"));
  assert.ok(md.includes("title: Session\n"));
  assert.ok(md.includes("kind: claude\n"));
  assert.ok(md.includes("cwd: C:\\WPAI\n"));
  assert.ok(md.includes("savedAt: 2024-01-05T09:07:03\n"));
  assert.ok(md.includes("---\n\nhello\nworld"));
});
test("journalMarkdown string-coerces and is null-safe", () => {
  const md = journalMarkdown({ title: null, kind: 7, cwd: undefined, savedAt: false, body: null });
  assert.ok(md.includes("title: \n"));
  assert.ok(md.includes("kind: 7\n"));
  assert.ok(md.includes("cwd: \n"));
  assert.ok(md.includes("savedAt: false\n"));
  assert.ok(md.endsWith("---\n\n") || md.endsWith("---\n\n"));
  // garbage opts
  assert.ok(typeof journalMarkdown(null) === "string");
  assert.ok(typeof journalMarkdown(undefined) === "string");
  assert.ok(typeof journalMarkdown("x") === "string");
  assert.ok(typeof journalMarkdown([]) === "string");
});

// ---------- normalizePins / togglePin / isPinned ----------
test("normalizePins: unique non-empty strings, max 40", () => {
  assert.deepEqual(normalizePins(["a", "b", "a", "", "  ", null, "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizePins('["/x","/y","/x"]'), ["/x", "/y"]);
  const many = Array.from({ length: 50 }, (_, i) => "/p" + i);
  assert.equal(normalizePins(many).length, 40);
  assert.equal(normalizePins(many)[0], "/p0");
  assert.equal(normalizePins(many)[39], "/p39");
});
test("normalizePins is garbage-safe", () => {
  assert.deepEqual(normalizePins(null), []);
  assert.deepEqual(normalizePins(undefined), []);
  assert.deepEqual(normalizePins({}), []);
  assert.deepEqual(normalizePins("not json"), []);
  assert.deepEqual(normalizePins("null"), []);
  assert.deepEqual(normalizePins(42), []);
  assert.deepEqual(normalizePins([1, 2, "  hi  "]), ["1", "2", "hi"]);
});
test("isPinned: membership by string path", () => {
  assert.equal(isPinned(["/a", "/b"], "/a"), true);
  assert.equal(isPinned(["/a", "/b"], "/c"), false);
  assert.equal(isPinned(["/a"], null), false);
  assert.equal(isPinned(["/a"], ""), false);
  assert.equal(isPinned(null, "/a"), false);
  assert.equal(isPinned(undefined, "/a"), false);
});
test("togglePin: add then remove; empty path no-op", () => {
  const a = togglePin([], "/proj");
  assert.deepEqual(a, ["/proj"]);
  const b = togglePin(a, "/proj");
  assert.deepEqual(b, []);
  assert.deepEqual(togglePin(["/x"], ""), ["/x"]);
  assert.deepEqual(togglePin(["/x"], null), ["/x"]);
  assert.deepEqual(togglePin(["/x"], "   "), ["/x"]);
  // does not mutate input
  const orig = ["/a"];
  const next = togglePin(orig, "/b");
  assert.deepEqual(orig, ["/a"]);
  assert.deepEqual(next, ["/a", "/b"]);
});
test("togglePin respects max 40 pins", () => {
  const full = Array.from({ length: 40 }, (_, i) => "/p" + i);
  const out = togglePin(full, "/new");
  assert.equal(out.length, 40);
  assert.equal(out.includes("/new"), false);
  // can still remove when full
  assert.equal(togglePin(full, "/p0").length, 39);
});

// ---------- rankItemsWithPins ----------
test("rankItemsWithPins: pinned projects get +1000 and sort first on empty query", () => {
  const items = [
    { name: "Alpha", kind: "project", path: "/a" },
    { name: "Beta", kind: "project", path: "/b" },
    { name: "Gamma", kind: "spell", path: "/g" },
  ];
  const out = rankItemsWithPins(items, "", 10, ["/b"]);
  assert.equal(out[0].name, "Beta");
  assert.equal(out.length, 3);
});
test("rankItemsWithPins: only kind=project is boosted", () => {
  const items = [
    { name: "Alpha", kind: "spell", path: "/a" },
    { name: "Beta", kind: "project", path: "/b" },
  ];
  const out = rankItemsWithPins(items, "", 10, ["/a", "/b"]);
  assert.equal(out[0].name, "Beta"); // only /b is a project pin
});
test("rankItemsWithPins: query still ranks, pin boost helps ties", () => {
  const items = [
    { name: "Git status", kind: "spell", path: "/g" },
    { name: "Git tools", kind: "project", path: "/p" },
  ];
  const out = rankItemsWithPins(items, "git", 10, ["/p"]);
  assert.equal(out[0].name, "Git tools");
  assert.equal(out.length, 2);
});
test("rankItemsWithPins: no pins behaves like rank (with sort on empty q)", () => {
  const items = [
    { name: "Zed", kind: "project", path: "/z" },
    { name: "Aye", kind: "project", path: "/a" },
  ];
  const out = rankItemsWithPins(items, "", 10, []);
  assert.equal(out.length, 2);
  // without boost, empty-query scores are all 1 so stable relative order preserved by equal scores...
  // our sort is b.s - a.s only; equal scores keep insertion order in modern V8 stable sort
  assert.equal(out[0].name, "Zed");
});
test("rankItemsWithPins: caps limit and tolerates garbage", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    name: "P" + i,
    kind: "project",
    path: "/p" + i,
  }));
  assert.equal(rankItemsWithPins(items, "", 2, ["/p4"]).length, 2);
  assert.equal(rankItemsWithPins(items, "", 2, ["/p4"])[0].path, "/p4");
  assert.deepEqual(rankItemsWithPins(null, "x", 10, null), []);
  assert.deepEqual(rankItemsWithPins(items, "", 0, []), []);
  assert.deepEqual(rankItemsWithPins(items, "", -1, []), []);
});

// ---------- reorderTabs ----------
test("reorderTabs moves id from fromIndex to toIndex", () => {
  assert.deepEqual(reorderTabs([10, 20, 30, 40], 0, 2), [20, 30, 10, 40]);
  assert.deepEqual(reorderTabs([10, 20, 30, 40], 3, 0), [40, 10, 20, 30]);
  assert.deepEqual(reorderTabs([10, 20, 30], 1, 1), [10, 20, 30]);
});
test("reorderTabs is garbage-safe (bad indices = copy)", () => {
  assert.deepEqual(reorderTabs([1, 2, 3], -1, 1), [1, 2, 3]);
  assert.deepEqual(reorderTabs([1, 2, 3], 0, 99), [1, 2, 3]);
  assert.deepEqual(reorderTabs([1, 2, 3], 1.5, 0), [1, 2, 3]);
  assert.deepEqual(reorderTabs([1, 2, 3], null, 0), [1, 2, 3]);
  assert.deepEqual(reorderTabs(null, 0, 1), []);
  assert.deepEqual(reorderTabs(undefined, 0, 1), []);
  assert.deepEqual(reorderTabs("x", 0, 1), []);
  // does not mutate
  const o = [1, 2, 3];
  reorderTabs(o, 0, 2);
  assert.deepEqual(o, [1, 2, 3]);
});

// ---------- roleTabClass ----------
test("roleTabClass maps known kinds", () => {
  assert.equal(roleTabClass("claude"), "role-orchestrator");
  assert.equal(roleTabClass("grok"), "role-executor");
  assert.equal(roleTabClass("ollama"), "role-local");
  assert.equal(roleTabClass("shell"), "role-shell");
  assert.equal(roleTabClass("other"), "role-shell");
});
test("roleTabClass is case-insensitive and null-safe", () => {
  assert.equal(roleTabClass("CLAUDE"), "role-orchestrator");
  assert.equal(roleTabClass("Grok"), "role-executor");
  assert.equal(roleTabClass(null), "role-shell");
  assert.equal(roleTabClass(undefined), "role-shell");
  assert.equal(roleTabClass(42), "role-shell");
});

// ---------- adversarial / fuzz: nothing should throw on bad input ----------
const BADS = [undefined, null, NaN, 0, -1, "", "x", {}, [], true, () => {}, Infinity];
function survives(fn) {
  for (const a of BADS)
    for (const b of BADS)
      for (const c of BADS) {
        try {
          fn(a, b, c);
        } catch (e) {
          assert.fail(`threw on (${String(a)},${String(b)},${String(c)}): ${e.message}`);
        }
      }
}

test("fuzz: fuzzy never throws", () => survives((a, b) => fuzzy(a, b)));
test("fuzz: rankItems never throws + always returns array", () => {
  for (const items of [null, undefined, {}, "x", [null, undefined, { name: "a" }], 5]) {
    const r = rankItems(items, "a", 10);
    assert.ok(Array.isArray(r));
  }
  survives((a, b, c) => rankItems(a, b, c));
});
test("fuzz: rankItems negative/zero limit yields empty", () => {
  const items = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(rankItems(items, "", -5), []);
  assert.deepEqual(rankItems(items, "", 0), []);
});
test("fuzz: visibleIds never throws + always array", () => {
  survives((a, b, c) => visibleIds(a, b, c));
  for (const o of [null, undefined, "x", 5, {}]) assert.deepEqual(visibleIds(o, 1, 2), []);
});
test("fuzz: layoutClass always returns l1|l2|l4", () => {
  for (const n of BADS.concat([1, 2, 3, 4, 99])) {
    const c = layoutClass(n);
    assert.ok(["l1", "l2", "l4"].includes(c), `bad class ${c} for ${String(n)}`);
  }
});
test("fuzz: buildShellArgs never throws + shape holds", () => {
  survives((a, b) => buildShellArgs(a, b));
  const r = buildShellArgs(null, null);
  assert.ok(Array.isArray(r.args));
  assert.ok("deferredRun" in r);
});
test("fuzz: gaugeHeight always 4..100", () => {
  for (const n of BADS.concat([-999, 999, 42.7]))
    assert.ok(gaugeHeight(n) >= 4 && gaugeHeight(n) <= 100);
});
test("fuzz: mergeSettings never throws + returns object", () => {
  survives((a, b) => mergeSettings(a, b));
  assert.equal(typeof mergeSettings(null, null), "object");
  assert.equal(typeof mergeSettings({ a: 1 }, "[]"), "object");
});
test("fuzz: commandFinished/shouldNotify/broadcastTargets/nextActiveAfterClose never throw", () => {
  survives((a, b) => commandFinished(a, b));
  survives((a, b, c) => shouldNotify(a, b, c, false));
  survives((a, b, c) => broadcastTargets(a, b, c));
  survives((a, b) => nextActiveAfterClose(a, b));
  assert.ok(Array.isArray(broadcastTargets(true, 1, null)));
  assert.equal(nextActiveAfterClose(null, 3), null);
});
test("fuzz: fmtUptime + parseGitStatus never throw", () => {
  for (const a of BADS) {
    fmtUptime(a);
    parseGitStatus(a);
  }
});
test("fuzz: sanitizeFilename / journalFilename / journalMarkdown never throw", () => {
  for (const a of BADS) {
    assert.equal(typeof sanitizeFilename(a), "string");
    assert.equal(typeof journalFilename(a, a), "string");
    assert.equal(typeof journalMarkdown(a), "string");
  }
  survives((a, b) => journalFilename(a, b));
  survives((a) => journalMarkdown(a));
});
test("fuzz: pin helpers never throw + always array/bool", () => {
  survives((a, b) => {
    assert.ok(Array.isArray(normalizePins(a)));
    assert.ok(Array.isArray(togglePin(a, b)));
    assert.equal(typeof isPinned(a, b), "boolean");
  });
});
test("fuzz: rankItemsWithPins never throws + always array", () => {
  for (const items of [null, undefined, {}, "x", [null, { name: "a" }], 5]) {
    assert.ok(Array.isArray(rankItemsWithPins(items, "a", 10, null)));
  }
  survives((a, b, c) => rankItemsWithPins(a, b, c, a));
});
test("fuzz: reorderTabs never throws + always array", () => {
  survives((a, b, c) => {
    const r = reorderTabs(a, b, c);
    assert.ok(Array.isArray(r));
  });
});
test("fuzz: roleTabClass always returns a role-* class", () => {
  for (const a of BADS) {
    const c = roleTabClass(a);
    assert.ok(/^role-/.test(c), `bad class ${c}`);
  }
});

// ---------- UMD: browser-context export path ----------
test("core.js attaches HFCore to global when module is absent (browser)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "core.js"), "utf8");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.HFCore, "object");
  assert.equal(typeof sandbox.HFCore.fuzzy, "function");
  assert.equal(sandbox.HFCore.layoutClass(2), "l2");
  assert.equal(sandbox.HFCore.roleTabClass("grok"), "role-executor");
  assert.equal(sandbox.HFCore.sanitizeFilename(""), "forge");
});
