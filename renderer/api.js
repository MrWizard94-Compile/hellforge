/**
 * HellForge API layer — pure, DOM-free logic for API-backed Council agents.
 *
 * The main process holds the keys and makes the HTTPS calls; this module is the
 * pure, testable glue: parsing keys out of a config file, mapping Council roles
 * to providers, building request payloads, and reading responses back. No key
 * value is ever logged or returned to the renderer. UMD like core.js.
 */
/* node:coverage disable */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HFApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* node:coverage enable */
  "use strict";

  const XAI_RE = /xai-[A-Za-z0-9_-]{20,}/;
  const ANTHROPIC_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;

  const DEFAULT_MODEL = { xai: "grok-4.5", anthropic: "claude-sonnet-5" };

  /**
   * Extract provider keys from a config file's text and/or environment.
   * Priority: explicit env vars, then `NAME=value` lines, then a bare token.
   * Returns `{ xai, anthropic }` with `""` where nothing was found. Never throws.
   */
  function extractKeys(text, env) {
    const src = String(text == null ? "" : text);
    const e = env && typeof env === "object" ? env : {};
    function find(envName, assignRe, tokenRe) {
      const fromEnv = e[envName];
      if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
      const assign = src.match(assignRe);
      if (assign) return assign[1].trim();
      const tok = src.match(tokenRe);
      return tok ? tok[0] : "";
    }
    return {
      xai: find("XAI_API_KEY", /XAI_API_KEY\s*[=:]\s*["'`]?([A-Za-z0-9_-]{20,})/, XAI_RE),
      anthropic: find(
        "ANTHROPIC_API_KEY",
        /ANTHROPIC_API_KEY\s*[=:]\s*["'`]?([A-Za-z0-9_-]{20,})/,
        ANTHROPIC_RE
      ),
    };
  }

  /** Which providers currently have a usable key. */
  function keyStatus(keys) {
    const k = keys && typeof keys === "object" ? keys : {};
    return {
      xai: !!(k.xai && String(k.xai).trim()),
      anthropic: !!(k.anthropic && String(k.anthropic).trim()),
    };
  }

  /** Council role -> API provider (executor=Grok/xai, orchestrator=Claude/anthropic). */
  function providerForRole(role) {
    const r = String(role == null ? "" : role).toLowerCase();
    if (r === "executor") return "xai";
    if (r === "orchestrator") return "anthropic";
    return null;
  }
  /** API provider -> the Council role it speaks as. */
  function roleForProvider(provider) {
    const p = String(provider == null ? "" : provider).toLowerCase();
    if (p === "xai") return "executor";
    if (p === "anthropic") return "orchestrator";
    return null;
  }

  function defaultModel(provider) {
    return DEFAULT_MODEL[String(provider == null ? "" : provider).toLowerCase()] || "";
  }

  /** System prompt establishing an agent's persona + team context by role. */
  function systemPromptFor(role) {
    const r = String(role == null ? "" : role).toLowerCase();
    const team =
      "You are part of HellForge's Council, a multi-agent team. The Director is the human. " +
      "Messages are relayed over a shared bus. Be concise and actionable; you are working, not chatting.";
    if (r === "executor")
      return "You are the Executor (Grok). You implement, build, and run things. " + team;
    if (r === "orchestrator")
      return (
        "You are the Orchestrator (Claude). You plan, review, and coordinate the team. " + team
      );
    return "You are a HellForge Council agent. " + team;
  }

  /**
   * Turn recent bus history + the dispatched prompt into a chat payload.
   * Returns `{ system, messages }` where messages are `{role:"user"|"assistant", content}`.
   * The speaking agent's own past posts map to "assistant"; everything else to
   * "user" (prefixed with who said it) so a single-model chat stays coherent.
   */
  function buildMessages(role, prompt, history) {
    const selfRole = String(role == null ? "" : role).toLowerCase();
    const hist = Array.isArray(history) ? history : [];
    const messages = [];
    for (const m of hist) {
      if (!m || typeof m !== "object") continue;
      const from = String(m.from == null ? "?" : m.from).toLowerCase();
      const text = String(m.text == null ? "" : m.text);
      if (!text) continue;
      if (from === selfRole) messages.push({ role: "assistant", content: text });
      else messages.push({ role: "user", content: "[" + from + "] " + text });
    }
    const p = String(prompt == null ? "" : prompt);
    if (p) messages.push({ role: "user", content: p });
    // A chat must start with a user turn; drop any leading assistant context.
    while (messages.length && messages[0].role !== "user") messages.shift();
    return { system: systemPromptFor(selfRole), messages };
  }

  /**
   * Build the HTTPS request for a provider. Pure: returns `{ url, headers, body }`
   * with the key injected into the auth header (caller performs the fetch).
   * Anthropic takes `system` as a top-level field; xAI folds it into a message.
   */
  function buildRequest(provider, key, model, system, messages, opts) {
    const p = String(provider == null ? "" : provider).toLowerCase();
    const o = opts && typeof opts === "object" ? opts : {};
    const maxTokens = Number(o.maxTokens) || 1024;
    const mdl = model || defaultModel(p);
    const msgs = Array.isArray(messages) ? messages : [];
    if (p === "anthropic") {
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": String(key == null ? "" : key),
          "anthropic-version": "2023-06-01",
        },
        body: { model: mdl, max_tokens: maxTokens, system: String(system || ""), messages: msgs },
      };
    }
    // xAI (OpenAI-compatible): system is the first message.
    const withSystem = system ? [{ role: "system", content: String(system) }].concat(msgs) : msgs;
    return {
      url: "https://api.x.ai/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + String(key == null ? "" : key),
      },
      body: { model: mdl, max_tokens: maxTokens, messages: withSystem, stream: false },
    };
  }

  /**
   * Read a provider's JSON response into `{ text, error }`. Handles the two
   * success shapes (xAI `choices[].message.content`, Anthropic `content[].text`)
   * and surfaces API error objects (e.g. permission-denied / no credits) as text.
   */
  function parseResponse(provider, obj) {
    const p = String(provider == null ? "" : provider).toLowerCase();
    if (obj == null || typeof obj !== "object") return { text: "", error: "empty response" };
    if (obj.error) {
      const e = obj.error;
      const msg = typeof e === "string" ? e : e && e.message ? e.message : "API error";
      return { text: "", error: String(msg) };
    }
    if (p === "anthropic") {
      const blocks = Array.isArray(obj.content) ? obj.content : [];
      const text = blocks
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      return { text, error: text ? "" : "no content" };
    }
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    const text =
      choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : "";
    return { text, error: text ? "" : "no content" };
  }

  return {
    extractKeys,
    keyStatus,
    providerForRole,
    roleForProvider,
    defaultModel,
    systemPromptFor,
    buildMessages,
    buildRequest,
    parseResponse,
  };
});
