interface RunnerLimits {
  readonly maxInputLineBytes: number;
  readonly maxControlInputLineBytes: number;
  readonly maxOutputLineBytes: number;
  readonly maxCookieBytes: number;
  readonly maxCookieWrites: number;
  readonly maxTimers: number;
  readonly maxTimerDelayMs: number;
}

export const makeBrowserScriptRunnerSource = (limits: RunnerLimits): string => {
  const bootstrap = String.raw`
(() => {
  const post = __post;
  const initialUrl = String(__pageUrl);
  const userAgent = String(__userAgent);
  const authoritativeCookies = Boolean(__authoritativeCookies);
  const utf8Length = (value) => {
    const text = String(value);
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  };
  const cookieMap = (value) => {
    const result = new Map();
    for (const part of String(value).split(";")) {
      const equals = part.indexOf("=");
      if (equals > 0) result.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
    }
    return result;
  };
  let visibleCookies = authoritativeCookies ? String(__cookie) : cookieMap(__cookie);
  let cookieVersion = 0;
  let acknowledgedCookieVersion = 0;
  let cookieBytes = 0;
  let cookieError = "";
  let pendingCookieWrites = [];
  const cookieWaiters = [];
  const pending = new Map();
  const timers = new Map();
  let nextRequestId = 0;
  let nextTimerId = 0;
  const send = (message) => {
    try { post(JSON.stringify(message)); } catch {}
  };
  const applyVisibleCookie = (text) => {
    const first = text.split(";", 1)[0] || "";
    const equals = first.indexOf("=");
    if (equals <= 0) return;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1).trim();
    const maxAge = /(?:^|;)\s*max-age\s*=\s*(-?\d+)/i.exec(text);
    if (maxAge && Number(maxAge[1]) <= 0) visibleCookies.delete(name);
    else visibleCookies.set(name, value);
  };
  const setCookie = (value) => {
    const text = String(value);
    if (/(?:^|;)\s*httponly(?:\s*=|;|$)/i.test(text)) return;
    const first = text.split(";", 1)[0] || "";
    if (first.indexOf("=") <= 0) return;
    const bytes = utf8Length(text);
    if (pendingCookieWrites.length >= ${limits.maxCookieWrites} || cookieBytes + bytes > ${limits.maxCookieBytes}) {
      cookieError = "script cookie output exceeds the configured limit";
      return;
    }
    cookieBytes += bytes;
    cookieVersion += 1;
    pendingCookieWrites.push({ version: cookieVersion, value: text });
    if (!authoritativeCookies) applyVisibleCookie(text);
    send({ type: "cookie.write", version: cookieVersion, value: text });
  };
  const syncCookies = (cookie, version, applied, error) => {
    if (error) {
      cookieError = String(error);
      for (const waiter of cookieWaiters.splice(0)) waiter.reject(new TypeError(cookieError));
      return;
    }
    if (applied && version >= acknowledgedCookieVersion) {
      acknowledgedCookieVersion = version;
      pendingCookieWrites = pendingCookieWrites.filter((entry) => entry.version > version);
      visibleCookies = authoritativeCookies ? String(cookie) : cookieMap(cookie);
      for (let index = cookieWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = cookieWaiters[index];
        if (waiter.version <= version) {
          cookieWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
    }
  };
  const flushCookies = () => {
    if (cookieError) return Promise.reject(new TypeError(cookieError));
    if (!authoritativeCookies || cookieVersion <= acknowledgedCookieVersion) return Promise.resolve();
    return new Promise((resolve, reject) => cookieWaiters.push({ version: cookieVersion, resolve, reject }));
  };
  const request = (kind, url, method, headers, body) => flushCookies().then(() => new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    pending.set(id, { resolve, reject, kind });
    send({ type: "network", id, kind, url: String(url), method, headers: Array.from(headers), body, cookieVersion });
  }));
  const safeMessage = (cause) => {
    try {
      if (typeof cause === "string") return cause;
      const message = cause && cause.message;
      return typeof message === "string" ? message : "script execution failed";
    } catch { return "script execution failed"; }
  };
  const fireTimer = (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    if (timer.interval === undefined) timers.delete(id);
    try { timer.callback(...timer.args); }
    catch (cause) { send({ type: "script.error", reason: safeMessage(cause) }); }
    if (timer.interval !== undefined && timers.get(id) === timer) {
      send({ type: "timer.set", id, ms: timer.interval });
    }
  };
  const receive = (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === "cookie.sync") {
      syncCookies(message.cookie, message.version, message.applied, message.error);
      return;
    }
    if (message.type === "timer.fire") {
      fireTimer(message.id);
      return;
    }
    if (message.type === "fatal") {
      send({ type: "script.error", reason: String(message.reason) });
      return;
    }
    if (message.type !== "reply") return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (!message.ok) {
      task.reject(new TypeError(String(message.error)));
      return;
    }
    const response = message.response;
    syncCookies(response.cookie, response.appliedCookieVersion, true, "");
    if (response.error) task.reject(new TypeError(String(response.error)));
    else task.resolve(response);
  };
  class Headers {
    constructor(input) {
      this.values = [];
      if (input instanceof Headers) {
        for (const [name, value] of input.values) this.append(name, value);
      } else if (Array.isArray(input)) {
        for (const pair of input) this.append(pair[0], pair[1]);
      } else if (input && typeof input === "object") {
        for (const [name, value] of Object.entries(input)) this.append(name, value);
      }
    }
    append(name, value) { this.values.push([String(name).toLowerCase(), String(value)]); }
    set(name, value) {
      const key = String(name).toLowerCase();
      this.values = this.values.filter(([entry]) => entry !== key);
      this.append(key, value);
    }
    get(name) {
      const key = String(name).toLowerCase();
      const values = this.values.filter(([entry]) => entry === key).map(([, value]) => value);
      return values.length === 0 ? null : values.join(", ");
    }
    has(name) { return this.values.some(([entry]) => entry === String(name).toLowerCase()); }
    forEach(callback, thisArg) {
      for (const [name, value] of this.values) callback.call(thisArg, value, name, this);
    }
    entries() { return this.values[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  class Response {
    constructor(value) {
      this.status = value.status;
      this.statusText = "";
      this.url = value.url;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(value.headers);
      this.bodyUsed = false;
      this.bodyText = value.body;
    }
    text() {
      if (this.bodyUsed) return Promise.reject(new TypeError("response body already used"));
      this.bodyUsed = true;
      return Promise.resolve(this.bodyText);
    }
    json() { return this.text().then((text) => JSON.parse(text)); }
  }
  const fetch = (input, init = {}) => {
    try {
      if (init.credentials !== undefined && init.credentials !== "same-origin") throw new TypeError("fetch credentials mode is not supported");
      if (init.redirect !== undefined && init.redirect !== "follow") throw new TypeError("fetch redirect mode is not supported");
      if (init.mode !== undefined) throw new TypeError("fetch mode is not supported");
      const url = typeof input === "string" ? input : input && input.url;
      if (typeof url !== "string") throw new TypeError("fetch expects a URL string");
      const method = String(init.method || "GET").toUpperCase();
      const body = init.body == null ? null : typeof init.body === "string" ? init.body : null;
      if (init.body != null && body === null) throw new TypeError("fetch supports string request bodies only");
      if ((method === "GET" || method === "HEAD") && body !== null) throw new TypeError("GET and HEAD cannot have a body");
      return request("fetch", url, method, new Headers(init.headers), body).then((value) => new Response(value));
    } catch (cause) { return Promise.reject(cause); }
  };
  function XMLHttpRequest() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.responseText = "";
    this.response = null;
    this.responseURL = "";
    this.responseType = "";
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onloadend = null;
    Object.defineProperty(this, "withCredentials", {
      enumerable: true,
      get: () => false,
      set: (value) => {
        if (value) throw new TypeError("XMLHttpRequest.withCredentials is not supported");
      },
    });
    this._headers = new Headers();
    this._listeners = new Map();
  }
  XMLHttpRequest.prototype.addEventListener = function(type, callback) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(callback);
    this._listeners.set(type, listeners);
  };
  XMLHttpRequest.prototype.removeEventListener = function(type, callback) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((entry) => entry !== callback));
  };
  XMLHttpRequest.prototype._emit = function(type) {
    const event = { type, target: this, currentTarget: this };
    const callbacks = [...(this._listeners.get(type) || [])];
    if (typeof this["on" + type] === "function") callbacks.push(this["on" + type]);
    for (const callback of callbacks) {
      try { callback.call(this, event); }
      catch (cause) { send({ type: "script.error", reason: safeMessage(cause) }); }
    }
  };
  XMLHttpRequest.prototype.open = function(method, url, async = true) {
    if (async === false) throw new TypeError("synchronous XMLHttpRequest is not supported");
    this._method = String(method).toUpperCase();
    this._url = String(url);
    this.readyState = 1;
    this._emit("readystatechange");
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.readyState !== 1) throw new TypeError("open() must be called before setRequestHeader()");
    this._headers.append(name, value);
  };
  XMLHttpRequest.prototype.send = function(body = null) {
    if (this.readyState !== 1) throw new TypeError("open() must be called before send()");
    if (body !== null && typeof body !== "string") throw new TypeError("XMLHttpRequest supports string request bodies only");
    request("fetch", this._url, this._method, this._headers, body).then((value) => {
      this.status = value.status;
      this.statusText = "";
      this.responseURL = value.url;
      this.responseText = value.body;
      this.response = this.responseType === "json" ? (() => { try { return JSON.parse(value.body); } catch { return null; } })() : value.body;
      this.readyState = 2; this._emit("readystatechange");
      this.readyState = 3; this._emit("readystatechange");
      this.readyState = 4; this._emit("readystatechange");
      this._emit("load"); this._emit("loadend");
    }, () => {
      this.status = 0;
      this.readyState = 4;
      this._emit("readystatechange");
      this._emit("error"); this._emit("loadend");
    });
  };
  const setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    if (timers.size >= ${limits.maxTimers}) throw new RangeError("script timer budget exceeded");
    const id = ++nextTimerId;
    const ms = Number.isFinite(Number(delay)) ? Math.max(0, Math.min(Number(delay), ${limits.maxTimerDelayMs})) : 0;
    timers.set(id, { callback, args });
    send({ type: "timer.set", id, ms });
    return id;
  };
  const setInterval = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("timer callback must be a function");
    if (timers.size >= ${limits.maxTimers}) throw new RangeError("script timer budget exceeded");
    const id = ++nextTimerId;
    const ms = Number.isFinite(Number(delay)) ? Math.max(0, Math.min(Number(delay), ${limits.maxTimerDelayMs})) : 0;
    timers.set(id, { callback, args, interval: ms });
    send({ type: "timer.set", id, ms });
    return id;
  };
  const clearTimeout = (id) => {
    const number = Number(id);
    if (timers.delete(number)) send({ type: "timer.clear", id: number });
  };
  const clearInterval = clearTimeout;
  class Event {
    constructor(type, options = {}) {
      const init = options == null ? {} : options;
      this._type = String(type);
      this._bubbles = Boolean(init.bubbles);
      this._cancelable = Boolean(init.cancelable);
      this._defaultPrevented = false;
      this._target = null;
      this._currentTarget = null;
      this._dispatching = false;
      this._immediateStopped = false;
      this._inPassiveListener = false;
    }
    get type() { return this._type; }
    get bubbles() { return this._bubbles; }
    get cancelable() { return this._cancelable; }
    get defaultPrevented() { return this._defaultPrevented; }
    get isTrusted() { return false; }
    get target() { return this._target; }
    get currentTarget() { return this._currentTarget; }
    preventDefault() {
      if (this.cancelable && !this._inPassiveListener) this._defaultPrevented = true;
    }
    stopImmediatePropagation() { this._immediateStopped = true; }
  }
  const makeEventTarget = (target) => {
    const listeners = new Map();
    const captureOf = (options) => typeof options === "boolean" ? options : Boolean(options && options.capture);
    target.addEventListener = (type, callback, options = false) => {
      if (callback == null) return;
      if (typeof callback !== "function" && (typeof callback !== "object" || typeof callback.handleEvent !== "function")) {
        throw new TypeError("event listener must be a function or an object with handleEvent");
      }
      const name = String(type);
      const capture = captureOf(options);
      const init = typeof options === "object" && options !== null ? options : {};
      if (init.signal != null) throw new TypeError("event listener AbortSignal is not supported");
      const entries = listeners.get(name) || [];
      if (entries.some((entry) => entry.callback === callback && entry.capture === capture)) return;
      entries.push({ callback, capture, once: Boolean(init.once), passive: Boolean(init.passive) });
      listeners.set(name, entries);
    };
    target.removeEventListener = (type, callback, options = false) => {
      if (callback == null) return;
      const name = String(type);
      const entries = listeners.get(name) || [];
      const index = entries.findIndex((entry) => entry.callback === callback && entry.capture === captureOf(options));
      if (index !== -1) entries.splice(index, 1);
      if (entries.length === 0) listeners.delete(name);
    };
    target.dispatchEvent = (event) => {
      if (!(event instanceof Event)) throw new TypeError("dispatchEvent expects an Event");
      if (event._dispatching) throw new TypeError("event is already being dispatched");
      const name = event.type;
      const entries = [...(listeners.get(name) || [])].sort(
        (left, right) => Number(right.capture) - Number(left.capture),
      );
      event._dispatching = true;
      event._target = target;
      event._currentTarget = target;
      event._immediateStopped = false;
      try {
        for (const entry of entries) {
          if (!(listeners.get(name) || []).includes(entry)) continue;
          if (entry.once) target.removeEventListener(name, entry.callback, entry.capture);
          try {
            event._inPassiveListener = entry.passive;
            if (typeof entry.callback === "function") entry.callback.call(target, event);
            else entry.callback.handleEvent.call(entry.callback, event);
          } catch (cause) {
            send({ type: "script.error", reason: safeMessage(cause) });
          } finally {
            event._inPassiveListener = false;
          }
          if (event._immediateStopped) break;
        }
      } finally {
        event._currentTarget = null;
        event._dispatching = false;
        event._inPassiveListener = false;
        event._immediateStopped = false;
      }
      return !event.defaultPrevented;
    };
    return target;
  };
  const document = makeEventTarget({});
  Object.defineProperty(document, "cookie", {
    enumerable: true,
    get: () => authoritativeCookies ? visibleCookies : Array.from(visibleCookies, ([name, value]) => name + "=" + value).join("; "),
    set: setCookie,
  });
  document.location = Object.freeze({ href: initialUrl });
  document.referrer = "";
  document.loadScript = (url) => request("script", String(url), "GET", new Headers([["accept", "text/javascript, application/javascript, */*"]]), null).then((value) => {
    if (value.status < 200 || value.status >= 300) throw new TypeError("script load failed with HTTP " + value.status);
    return undefined;
  });
  const navigator = Object.freeze({ userAgent, language: "en-US", languages: Object.freeze(["en-US"]), cookieEnabled: true, webdriver: false });
  const console = Object.freeze({ log() {}, warn() {}, error() {}, info() {} });
  const window = makeEventTarget(globalThis);
  Object.assign(window, { document, location: document.location, navigator, console, fetch, XMLHttpRequest, setTimeout, clearTimeout, setInterval, clearInterval, Headers, Response, Event });
  window.window = window; window.self = window; window.globalThis = window;
  Object.defineProperty(globalThis, "__receive", { value: receive, configurable: true });
  Object.defineProperty(globalThis, "__cookieSnapshot", {
    configurable: true,
    value: () => JSON.stringify({ setCookies: pendingCookieWrites.map((entry) => entry.value), error: cookieError }),
  });
  Object.defineProperty(globalThis, "__cookieFlush", { value: flushCookies, configurable: true });
  Object.defineProperty(globalThis, "__safeMessage", { value: safeMessage, configurable: true });
})();
`;

  return String.raw`
const vm = require("node:vm");
const readline = require("node:readline");
const MAX_INPUT_LINE_BYTES = ${limits.maxInputLineBytes};
const MAX_CONTROL_INPUT_LINE_BYTES = ${limits.maxControlInputLineBytes};
const MAX_OUTPUT_LINE_BYTES = ${limits.maxOutputLineBytes};
const pendingKinds = new Map();
let context;
let deliver;
let finished = false;
const safeMessage = (cause) => {
  try {
    if (typeof cause === "string") return cause;
    const message = cause && cause.message;
    return typeof message === "string" ? message : "script execution failed";
  } catch { return "script execution failed"; }
};
const writeFinal = (output) => {
  if (finished) return;
  finished = true;
  process.stdout.end(JSON.stringify({ type: "result", output }) + "\n", () => process.exit(0));
};
const post = (line) => {
  try {
    if (typeof line !== "string" || Buffer.byteLength(line) > MAX_OUTPUT_LINE_BYTES) {
      process.stdout.write(JSON.stringify({ type: "script.error", reason: "runner message exceeds the limit" }) + "\n");
      return;
    }
    const message = JSON.parse(line);
    if (message.type === "network") pendingKinds.set(message.id, message.kind);
    process.stdout.write(line + "\n");
  } catch {}
};
const bootstrap = ${JSON.stringify(bootstrap)};
const handleParentLine = (line) => {
  try {
    if (Buffer.byteLength(line) > MAX_INPUT_LINE_BYTES) throw new Error("host IPC line exceeds the limit");
    let message = JSON.parse(line);
    if (message.type === "fatal") {
      writeFinal({ ok: false, reason: String(message.reason) });
      return;
    }
    if (message.type === "reply") {
      const kind = pendingKinds.get(message.id);
      pendingKinds.delete(message.id);
      if (message.ok && kind === "script") {
        if (!message.response.error && message.response.status >= 200 && message.response.status < 300) {
          try { vm.runInContext(message.response.body, context); }
          catch (cause) {
            message = { type: "reply", id: message.id, ok: false, error: "loaded script failed: " + safeMessage(cause) };
          }
        }
        if (message.ok) message.response.body = "";
      }
    }
    deliver(JSON.stringify(message));
  } catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
};
const start = (input) => {
  const sandbox = Object.assign(Object.create(null), {
    __post: post,
    __pageUrl: String(input.url),
    __cookie: String(input.cookie),
    __userAgent: String(input.userAgent),
    __authoritativeCookies: input.authoritativeCookies,
  });
  context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(bootstrap, context);
  deliver = vm.runInContext("__receive", context);
  delete sandbox.__post;
  delete sandbox.__pageUrl;
  delete sandbox.__cookie;
  delete sandbox.__userAgent;
  delete sandbox.__receive;
  const wrapper = "(async function () {\n" +
    "  const snapshot = __cookieSnapshot; const flush = __cookieFlush; const describe = __safeMessage;\n" +
    "  delete globalThis.__cookieSnapshot; delete globalThis.__cookieFlush; delete globalThis.__safeMessage;\n" +
    "  try { const value = await (async function () {\n" + input.source + "\n})(); await flush();\n" +
    "    const state = JSON.parse(snapshot()); if (state.error) return JSON.stringify({ ok: false, reason: state.error });\n" +
    "    return JSON.stringify({ ok: true, value: String(value == null ? \"\" : value), setCookies: state.setCookies });\n" +
    "  } catch (cause) { try { await flush(); } catch (flushCause) { cause = flushCause; } const state = JSON.parse(snapshot()); return JSON.stringify({ ok: false, reason: describe(cause), setCookies: state.setCookies }); }\n" +
    "})()";
  try {
    Promise.resolve(vm.runInContext(wrapper, context)).then((encoded) => {
      try { writeFinal(JSON.parse(encoded)); }
      catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
    }, (cause) => writeFinal({ ok: false, reason: safeMessage(cause) }));
  } catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
};
const major = Number.parseInt(process.versions.node, 10);
if (!Number.isInteger(major) || major < 25 || process.permission?.has("net") !== false) {
  writeFinal({ ok: false, reason: "BrowserMock requires Node 25+ network permission denial support" });
} else {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let started = false;
  lines.on("line", (line) => {
    if (finished) return;
    const lineLimit = started
      ? MAX_INPUT_LINE_BYTES
      : MAX_CONTROL_INPUT_LINE_BYTES;
    if (Buffer.byteLength(line) > lineLimit) {
      writeFinal({ ok: false, reason: "host IPC line exceeds the limit" });
      return;
    }
    if (!started) {
      started = true;
      try { start(JSON.parse(line)); }
      catch (cause) { writeFinal({ ok: false, reason: safeMessage(cause) }); }
      return;
    }
    handleParentLine(line);
  });
}
`;
};
