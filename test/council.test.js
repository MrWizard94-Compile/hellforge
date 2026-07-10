/**
 * Spec for renderer/council.js — HellForge's multi-agent comms layer (HFCouncil).
 *
 * These tests are the contract. The implementation (authored by the headless
 * Grok executor, integrated and verified by the Claude orchestrator) must make
 * every one pass without modification. Pure, DOM-free logic only — the message
 * bus + PTY dispatch live in main.js / app.js and call into this.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  roleFor,
  roleMeta,
  makeMessage,
  serializeMsg,
  parseBus,
  resolveTargets,
  formatForPty,
  mentions,
  filterBus,
  formatBusExport,
} = require("../renderer/council.js");

// ---- roleFor: forge kind -> collaboration role ----
test("roleFor maps the three agents and defaults everything else to shell", () => {
  assert.equal(roleFor("claude"), "orchestrator");
  assert.equal(roleFor("grok"), "executor");
  assert.equal(roleFor("ollama"), "local");
  assert.equal(roleFor("shell"), "shell");
  assert.equal(roleFor("anything-unknown"), "shell");
});
test("roleFor is case-insensitive and null-safe", () => {
  assert.equal(roleFor("CLAUDE"), "orchestrator");
  assert.equal(roleFor("Grok"), "executor");
  assert.equal(roleFor(null), "shell");
  assert.equal(roleFor(undefined), "shell");
  assert.equal(roleFor(42), "shell");
});

// ---- roleMeta: display label + icon for a role ----
test("roleMeta returns label + icon for every known role incl. director", () => {
  for (const r of ["orchestrator", "executor", "local", "shell", "director"]) {
    const m = roleMeta(r);
    assert.equal(typeof m.label, "string");
    assert.ok(m.label.length > 0);
    assert.equal(typeof m.icon, "string");
    assert.ok(m.icon.length > 0);
  }
  assert.equal(roleMeta("orchestrator").label, "Orchestrator");
  assert.equal(roleMeta("executor").label, "Executor");
  assert.equal(roleMeta("local").label, "Local");
  assert.equal(roleMeta("director").label, "Director");
});
test("roleMeta falls back to the shell meta for unknown/garbage roles", () => {
  assert.deepEqual(roleMeta("nonsense"), roleMeta("shell"));
  assert.deepEqual(roleMeta(null), roleMeta("shell"));
  assert.deepEqual(roleMeta(undefined), roleMeta("shell"));
});

// ---- makeMessage: normalized, deterministic message record ----
test("makeMessage builds a normalized record", () => {
  const m = makeMessage("director", "executor", "build it", 1000);
  assert.deepEqual(m, { ts: 1000, from: "director", to: "executor", text: "build it" });
});
test("makeMessage coerces bad inputs to safe defaults", () => {
  const m = makeMessage(null, undefined, null, NaN);
  assert.equal(m.ts, 0);
  assert.equal(m.from, "?");
  assert.equal(m.to, "all");
  assert.equal(m.text, "");
  assert.equal(typeof makeMessage(1, 2, 3, "x").ts, "number");
});

// ---- serialize / parse round-trip for the bus (jsonl) ----
test("serializeMsg is a single line that round-trips through parseBus", () => {
  const m = makeMessage("orchestrator", "all", "line one\nline two", 5);
  const line = serializeMsg(m);
  assert.ok(!line.includes("\n"), "serialized message must be one physical line");
  const back = parseBus(line);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], m);
});
test("serializeMsg falls back to an empty message for non-object garbage", () => {
  for (const bad of [null, undefined, 42, "x", [1, 2]]) {
    const line = serializeMsg(bad);
    assert.ok(!line.includes("\n"), "fallback must still be one line");
    const back = parseBus(line);
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], { ts: 0, from: "?", to: "all", text: "" });
  }
});
test("parseBus reads many lines and skips blank/garbage ones", () => {
  const good1 = serializeMsg(makeMessage("a", "b", "hi", 1));
  const good2 = serializeMsg(makeMessage("c", "d", "yo", 2));
  const text = ["", good1, "   ", "{not json", good2, "null", "42", ""].join("\n");
  const msgs = parseBus(text);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, "hi");
  assert.equal(msgs[1].text, "yo");
});
test("parseBus is null/garbage-safe", () => {
  assert.deepEqual(parseBus(null), []);
  assert.deepEqual(parseBus(undefined), []);
  assert.deepEqual(parseBus(""), []);
  assert.deepEqual(parseBus(12345), []);
});

// ---- resolveTargets: which forge ids a message is delivered to ----
const FORGES = [
  { id: 1, role: "orchestrator" },
  { id: 2, role: "executor" },
  { id: 3, role: "local" },
  { id: 4, role: "executor" },
];
test("resolveTargets: 'all' (and empty/star) fans out to every forge", () => {
  assert.deepEqual(resolveTargets("all", FORGES), [1, 2, 3, 4]);
  assert.deepEqual(resolveTargets("ALL", FORGES), [1, 2, 3, 4]);
  assert.deepEqual(resolveTargets("*", FORGES), [1, 2, 3, 4]);
  assert.deepEqual(resolveTargets("", FORGES), [1, 2, 3, 4]);
  assert.deepEqual(resolveTargets(null, FORGES), [1, 2, 3, 4]);
});
test("resolveTargets: a role selects every forge with that role", () => {
  assert.deepEqual(resolveTargets("executor", FORGES), [2, 4]);
  assert.deepEqual(resolveTargets("orchestrator", FORGES), [1]);
  assert.deepEqual(resolveTargets("local", FORGES), [3]);
  assert.deepEqual(resolveTargets("shell", FORGES), []);
});
test("resolveTargets: a specific id (number or numeric string) selects just it", () => {
  assert.deepEqual(resolveTargets(3, FORGES), [3]);
  assert.deepEqual(resolveTargets("3", FORGES), [3]);
  assert.deepEqual(resolveTargets(99, FORGES), []);
});
test("resolveTargets is garbage-safe", () => {
  assert.deepEqual(resolveTargets("executor", null), []);
  assert.deepEqual(resolveTargets({}, FORGES), []);
  assert.deepEqual(resolveTargets("executor", [{}, { id: 2, role: "executor" }]), [2]);
});

// ---- formatForPty: turn a message into bytes typed into a terminal ----
test("formatForPty appends a single carriage return and trims trailing newlines", () => {
  assert.equal(formatForPty("ls -la"), "ls -la\r");
  assert.equal(formatForPty("ls -la\n"), "ls -la\r");
  assert.equal(formatForPty("ls\r\n"), "ls\r");
});
test("formatForPty returns empty string for empty/whitespace/garbage input", () => {
  assert.equal(formatForPty(""), "");
  assert.equal(formatForPty("   "), "");
  assert.equal(formatForPty(null), "");
  assert.equal(formatForPty(undefined), "");
});

// ---- mentions: parse @role / @all routing tokens out of free text ----
test("mentions extracts @tokens, lowercased and de-duplicated in order", () => {
  assert.deepEqual(mentions("@executor please build, then @executor test"), ["executor"]);
  assert.deepEqual(mentions("@All hands: @Local review @executor"), ["all", "local", "executor"]);
  assert.deepEqual(mentions("no mentions here"), []);
});
test("mentions is garbage-safe", () => {
  assert.deepEqual(mentions(null), []);
  assert.deepEqual(mentions(42), []);
  assert.deepEqual(mentions(""), []);
});

// ---- filterBus: case-insensitive filter by text/from/to ----
const BUS_MSGS = [
  makeMessage("director", "executor", "Build the forge", 1000),
  makeMessage("executor", "all", "Done building", 2000),
  makeMessage("orchestrator", "local", "Review please", 3000),
];
test("filterBus: empty query returns all valid messages", () => {
  assert.equal(filterBus(BUS_MSGS, "").length, 3);
  assert.equal(filterBus(BUS_MSGS, null).length, 3);
  assert.equal(filterBus(BUS_MSGS, undefined).length, 3);
});
test("filterBus matches text, from, and to case-insensitively", () => {
  assert.equal(filterBus(BUS_MSGS, "build").length, 2);
  assert.equal(filterBus(BUS_MSGS, "DIRECTOR").length, 1);
  assert.equal(filterBus(BUS_MSGS, "Local").length, 1);
  assert.equal(filterBus(BUS_MSGS, "review").length, 1);
  assert.equal(filterBus(BUS_MSGS, "nope").length, 0);
});
test("filterBus is garbage-safe and skips invalid entries", () => {
  assert.deepEqual(filterBus(null, "x"), []);
  assert.deepEqual(filterBus(undefined, ""), []);
  assert.deepEqual(filterBus("x", "x"), []);
  assert.deepEqual(filterBus(42, "x"), []);
  const mixed = [null, undefined, "x", 1, [], BUS_MSGS[0], { text: "hi", from: "a", to: "b" }];
  assert.equal(filterBus(mixed, "").length, 2);
  assert.equal(filterBus(mixed, "hi").length, 1);
  assert.equal(filterBus([{ text: null, from: null, to: null }], "z").length, 0);
  assert.equal(filterBus([{ text: null, from: null, to: null }], "").length, 1);
});

// ---- formatBusExport: markdown transcript ----
test("formatBusExport starts with header and includes message fields", () => {
  const md = formatBusExport(BUS_MSGS);
  assert.ok(md.startsWith("# Council Bus Export"));
  assert.ok(md.includes("**from:** director"));
  assert.ok(md.includes("**to:** executor"));
  assert.ok(md.includes("Build the forge"));
  assert.ok(md.includes("Done building"));
  assert.ok(md.includes("Review please"));
});
test("formatBusExport is null-safe and skips garbage entries", () => {
  assert.equal(formatBusExport(null).startsWith("# Council Bus Export"), true);
  assert.equal(formatBusExport(undefined).startsWith("# Council Bus Export"), true);
  assert.equal(formatBusExport("x").startsWith("# Council Bus Export"), true);
  const md = formatBusExport([null, "x", makeMessage("a", "b", "hi", 0)]);
  assert.ok(md.includes("**from:** a"));
  assert.ok(md.includes("hi"));
  // missing fields
  const sparse = formatBusExport([{ ts: null, from: null, to: null, text: null }]);
  assert.ok(sparse.includes("**from:** ?"));
  assert.ok(sparse.includes("**to:** all"));
});

// ---- adversarial fuzz: nothing throws on garbage ----
const BADS = [undefined, null, NaN, 0, -1, "", "x", {}, [], true, () => {}, Infinity];
function survives(fn) {
  for (const a of BADS) for (const b of BADS) assert.doesNotThrow(() => fn(a, b));
}
test("fuzz: every exported fn tolerates garbage without throwing", () => {
  survives((a) => roleFor(a));
  survives((a) => roleMeta(a));
  survives((a, b) => makeMessage(a, b, a, b));
  survives((a, b) => serializeMsg(makeMessage(a, b, a, b)));
  survives((a) => parseBus(a));
  survives((a, b) => resolveTargets(a, b));
  survives((a) => formatForPty(a));
  survives((a) => mentions(a));
  survives((a, b) => filterBus(a, b));
  survives((a) => formatBusExport(a));
});

// ---- UMD: attaches to global when module is absent (browser <script>) ----
test("council.js attaches HFCouncil to global when module is absent (browser)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "council.js"), "utf8");
  const sandbox = { globalThis: {} };
  sandbox.self = sandbox.globalThis;
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.globalThis.HFCouncil, "object");
  assert.equal(sandbox.globalThis.HFCouncil.roleFor("grok"), "executor");
  assert.equal(typeof sandbox.globalThis.HFCouncil.filterBus, "function");
  assert.equal(typeof sandbox.globalThis.HFCouncil.formatBusExport, "function");
});
