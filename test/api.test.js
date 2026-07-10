/**
 * Spec for renderer/api.js (HFApi) — the pure logic behind API-backed Council
 * agents. All keys here are FAKE fixtures. Real keys live only in the main
 * process at runtime and never appear in code, tests, logs, or the bus.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  extractKeys,
  keyStatus,
  providerForRole,
  roleForProvider,
  defaultModel,
  systemPromptFor,
  buildMessages,
  buildRequest,
  parseResponse,
} = require("../renderer/api.js");

const FAKE_XAI = "xai-ABCDEFGHIJKLMNOPQRSTUVWX1234";
const FAKE_ANTH = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX1234";

// ---- extractKeys ----
test("extractKeys prefers explicit env vars", () => {
  const k = extractKeys("nothing here", { XAI_API_KEY: FAKE_XAI, ANTHROPIC_API_KEY: FAKE_ANTH });
  assert.equal(k.xai, FAKE_XAI);
  assert.equal(k.anthropic, FAKE_ANTH);
});
test("extractKeys reads NAME=value assignments", () => {
  const text = `XAI_API_KEY=${FAKE_XAI}\nANTHROPIC_API_KEY="${FAKE_ANTH}"`;
  const k = extractKeys(text, {});
  assert.equal(k.xai, FAKE_XAI);
  assert.equal(k.anthropic, FAKE_ANTH);
});
test("extractKeys falls back to a bare token in the file", () => {
  const text = "here is my key `" + FAKE_XAI + "` and " + FAKE_ANTH + " somewhere";
  const k = extractKeys(text, {});
  assert.equal(k.xai, FAKE_XAI);
  assert.equal(k.anthropic, FAKE_ANTH);
});
test("extractKeys returns empty strings when nothing is present", () => {
  const k = extractKeys("no secrets here", {});
  assert.equal(k.xai, "");
  assert.equal(k.anthropic, "");
});
test("extractKeys is null/garbage-safe", () => {
  assert.deepEqual(extractKeys(null, null), { xai: "", anthropic: "" });
  assert.deepEqual(extractKeys(undefined, 42), { xai: "", anthropic: "" });
});

// ---- keyStatus ----
test("keyStatus reports presence per provider", () => {
  assert.deepEqual(keyStatus({ xai: FAKE_XAI, anthropic: "" }), { xai: true, anthropic: false });
  assert.deepEqual(keyStatus({ xai: "  ", anthropic: FAKE_ANTH }), { xai: false, anthropic: true });
  assert.deepEqual(keyStatus(null), { xai: false, anthropic: false });
});

// ---- role/provider mapping ----
test("providerForRole / roleForProvider map executor<->xai, orchestrator<->anthropic", () => {
  assert.equal(providerForRole("executor"), "xai");
  assert.equal(providerForRole("orchestrator"), "anthropic");
  assert.equal(providerForRole("local"), null);
  assert.equal(providerForRole("garbage"), null);
  assert.equal(roleForProvider("xai"), "executor");
  assert.equal(roleForProvider("anthropic"), "orchestrator");
  assert.equal(roleForProvider("nope"), null);
});
test("defaultModel returns a model per provider, empty for unknown", () => {
  assert.equal(defaultModel("xai"), "grok-4.5");
  assert.ok(defaultModel("anthropic").startsWith("claude"));
  assert.equal(defaultModel("mystery"), "");
});

// ---- systemPromptFor ----
test("systemPromptFor is role-specific and never empty", () => {
  assert.match(systemPromptFor("executor"), /Executor/);
  assert.match(systemPromptFor("orchestrator"), /Orchestrator/);
  assert.ok(systemPromptFor("shell").length > 0);
  assert.ok(systemPromptFor(null).length > 0);
});

// ---- buildMessages ----
test("buildMessages maps self posts to assistant and others to prefixed user", () => {
  const history = [
    { from: "director", text: "build the parser" },
    { from: "executor", text: "on it" },
    { from: "local", text: "i'll review" },
  ];
  const { system, messages } = buildMessages("executor", "status?", history);
  assert.match(system, /Executor/);
  assert.deepEqual(messages, [
    { role: "user", content: "[director] build the parser" },
    { role: "assistant", content: "on it" },
    { role: "user", content: "[local] i'll review" },
    { role: "user", content: "status?" },
  ]);
});
test("buildMessages drops leading assistant turns so chat starts with a user", () => {
  const { messages } = buildMessages("executor", "go", [{ from: "executor", text: "prior" }]);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[messages.length - 1].content, "go");
});
test("buildMessages tolerates empty prompt and garbage history entries", () => {
  const { messages } = buildMessages("orchestrator", "", [
    null,
    5,
    { from: "director", text: "hi" },
  ]);
  assert.deepEqual(messages, [{ role: "user", content: "[director] hi" }]);
});

// ---- buildRequest ----
test("buildRequest builds the xAI (OpenAI-compatible) shape with system folded in", () => {
  const r = buildRequest("xai", FAKE_XAI, null, "SYS", [{ role: "user", content: "hi" }], {});
  assert.equal(r.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(r.headers.authorization, "Bearer " + FAKE_XAI);
  assert.equal(r.body.model, "grok-4.5");
  assert.deepEqual(r.body.messages[0], { role: "system", content: "SYS" });
  assert.equal(r.body.stream, false);
});
test("buildRequest builds the Anthropic shape with system as a top-level field", () => {
  const r = buildRequest(
    "anthropic",
    FAKE_ANTH,
    "claude-x",
    "SYS",
    [{ role: "user", content: "hi" }],
    {
      maxTokens: 256,
    }
  );
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], FAKE_ANTH);
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.max_tokens, 256);
  assert.equal(r.body.model, "claude-x");
  assert.equal(r.body.messages[0].content, "hi");
});

// ---- parseResponse ----
test("parseResponse reads the xAI success shape", () => {
  const r = parseResponse("xai", { choices: [{ message: { content: "done" } }] });
  assert.deepEqual(r, { text: "done", error: "" });
});
test("parseResponse reads the Anthropic success shape (concatenated text blocks)", () => {
  const r = parseResponse("anthropic", {
    content: [
      { type: "text", text: "hello " },
      { type: "tool_use" },
      { type: "text", text: "world" },
    ],
  });
  assert.equal(r.text, "hello world");
  assert.equal(r.error, "");
});
test("parseResponse surfaces API error objects (string and {message})", () => {
  assert.equal(parseResponse("xai", { error: "permission-denied" }).error, "permission-denied");
  assert.equal(
    parseResponse("anthropic", { error: { message: "no credits" } }).error,
    "no credits"
  );
});
test("parseResponse handles empty/garbage", () => {
  assert.equal(parseResponse("xai", null).error, "empty response");
  assert.equal(parseResponse("xai", { choices: [] }).error, "no content");
});
test("parseResponse falls back to 'API error' for an opaque error object", () => {
  assert.equal(parseResponse("xai", { error: {} }).error, "API error");
  assert.equal(parseResponse("anthropic", { error: 123 }).error, "API error");
});
test("buildRequest omits system when none is given (both providers)", () => {
  const x = buildRequest("xai", "k", null, "", [{ role: "user", content: "hi" }], {});
  assert.equal(x.body.messages[0].role, "user");
  const a = buildRequest("anthropic", "k", "m", null, [{ role: "user", content: "hi" }], {});
  assert.equal(a.body.system, "");
});
test("buildMessages skips history entries with empty text", () => {
  const { messages } = buildMessages("executor", "go", [
    { from: "director", text: "" },
    { from: "director", text: "real" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "[director] real" },
    { role: "user", content: "go" },
  ]);
});

// ---- adversarial fuzz ----
const BADS = [undefined, null, NaN, 0, -1, "", "x", {}, [], true, () => {}, Infinity];
function survives(fn) {
  for (const a of BADS) for (const b of BADS) assert.doesNotThrow(() => fn(a, b));
}
test("fuzz: every exported fn tolerates garbage without throwing", () => {
  survives((a, b) => extractKeys(a, b));
  survives((a) => keyStatus(a));
  survives((a) => providerForRole(a));
  survives((a) => roleForProvider(a));
  survives((a) => defaultModel(a));
  survives((a) => systemPromptFor(a));
  survives((a, b) => buildMessages(a, b, a));
  survives((a, b) => buildRequest(a, b, a, b, a, b));
  survives((a, b) => parseResponse(a, b));
});

// ---- UMD ----
test("api.js attaches HFApi to global when module is absent (browser)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "api.js"), "utf8");
  const sandbox = { globalThis: {} };
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.globalThis.HFApi, "object");
  assert.equal(sandbox.globalThis.HFApi.providerForRole("executor"), "xai");
});
