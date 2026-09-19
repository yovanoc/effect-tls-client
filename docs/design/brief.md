# Effect-native tls-client — Architecture Grilling

I want to design an open-source Effect library around:

https://github.com/bogdanfinn/tls-client

Do **not** start implementing yet.

Grill me thoroughly before implementation. The objective is to discover the right architecture, abstractions, API, package boundaries, and lifecycle model rather than merely confirm the architecture I currently have in mind.

Research aggressively before asking questions. If something can be determined from source code, examples, Effect APIs, existing repositories, or upstream behavior, investigate it yourself instead of asking me.

Ask me about **design decisions, requirements, and tradeoffs** that cannot be determined through research.

Ask **one meaningful decision question at a time** and use each answer to determine the next branch of the grilling.

---

# What I ultimately want

At the lowest level, I want to consume the native/shared-library interface of `bogdanfinn/tls-client` from TypeScript.

But the goal is **not** merely to create typed bindings.

I want to determine what a genuinely Effect-native integration should look like.

In particular, `tls-client` should ideally become something that composes naturally through Effect Services, Layers, Scope, Schema, Stream, `@effect/platform`, etc.

One important use case is being able to provide a `tls-client`-backed implementation/layer for Effect's `HttpClient`, allowing an application to replace the normal Node/Bun HTTP transport with a fingerprinted `tls-client` transport through normal Layer composition.

However, do not assume `HttpClient` should be the central abstraction. `tls-client` has capabilities and state that may not map naturally onto `HttpClient`.

The API should feel like an Effect library designed around Effect semantics, not like a Node wrapper with `Effect.tryPromise` added around it.

---

# Research first

Before grilling me deeply about architecture, inspect the relevant implementations and establish the factual constraints.

## 1. tls-client — authoritative upstream

https://github.com/bogdanfinn/tls-client

Current source on `master` is authoritative.

Inspect the implementation, not only the README.

In particular inspect:

- `cffi_dist/main.go`
- `cffi_src/`
- related native/shared-library implementation
- session management
- memory ownership
- exported functions
- request/response structures
- TLS/client-profile configuration
- HTTP/1.1, HTTP/2 and HTTP/3 support
- cookies
- proxies
- streaming
- bandwidth/event functionality
- WebSocket implementation
- anything else relevant that you discover

Build a mental capability map of:

1. what the Go library supports;
2. what the shared-library/CFFI API currently exposes;
3. what exists upstream but is not currently exposed through CFFI.

Do not infer CFFI capabilities merely because the Go library supports something.

Likewise, do not assume something is unavailable because an older example or wrapper does not expose it.

## 2. Official Node CFFI examples

Inspect **all relevant examples** here:

https://github.com/bogdanfinn/tls-client/tree/master/cffi_dist/example_node

These are important because they demonstrate how upstream itself expects JavaScript/Node consumers to interact directly with the shared library.

Understand things such as:

- shared-library loading;
- native function signatures;
- JSON serialization across the ABI;
- request construction;
- response decoding;
- pointer ownership;
- `freeMemory`;
- sessions;
- cookies;
- binary requests/responses;
- custom TLS configuration;
- proxies;
- platform-specific behavior;
- errors;
- lifecycle;
- concurrency assumptions;
- anything else demonstrated by the examples.

Do **not** copy the examples' API design. They describe the native boundary that our Effect abstraction should hide.

If the examples and current source disagree, current source wins.

## 3. WebSocket CFFI work

Investigate:

https://github.com/bogdanfinn/tls-client/issues/240

and the related:

https://github.com/bogdanfinn/tls-client/pull/251

Determine the actual current state from source and git history rather than relying solely on issue labels/status.

Understand the proposed/implemented CFFI WebSocket design even if it is not currently merged, because it may influence an API we want to support later or contribute upstream.

Do not design the entire library around hypothetical future functionality, though.

## 4. Existing Node wrapper

Inspect:

https://github.com/fatihkabakk/tls-client-node

Use this as a reference, not as the architecture we should reproduce.

I'm particularly interested in what can be learned from it about:

- native binary downloading;
- native binary discovery;
- versioning;
- platform/architecture detection;
- loading the shared library;
- installation behavior;
- session lifecycle;
- JS/TS ergonomics;
- packaging;
- failure modes.

Determine which ideas are useful and which are unnecessary or inappropriate for an Effect-native library.

## 5. My existing Effect library

Inspect:

https://github.com/yovanoc/effect-cdp

I already built this open-source Effect library.

Use it as a reference for:

- Effect coding style;
- Service/Layer patterns;
- Schema usage;
- package structure;
- tests;
- documentation;
- publishing;
- repository organization;
- GitHub Actions;
- general project conventions.

Do not assume every choice there is still the best choice.

## 6. More recent repository/tooling

Inspect:

https://github.com/yovanoc/jev-pm

This is newer than `effect-cdp`.

Compare its development/tooling configuration against `effect-cdp`, particularly where relevant:

- TypeScript;
- package manager;
- oxfmt;
- oxlint;
- VS Code;
- GitHub Actions;
- tsconfig;
- testing;
- publishing/build configuration;
- other modern repository conventions.

Use whichever conventions are currently better rather than blindly cloning either repository.

## 7. My existing browser POC

Inspect this local directory carefully:

`/Users/yovanoc/projects/slicethepie/src/browser`

This is ugly POC code, not an architecture to copy.

It is nevertheless probably the most important reference for understanding what I ultimately want to accomplish.

Understand:

- what problem it solves;
- how it uses Effect;
- how HTTP is represented;
- how browser/session state is represented;
- how DOM/environment mocking works;
- how navigation works;
- what abstractions emerged naturally;
- what parts are accidental POC complexity;
- what parts could become legitimate reusable abstractions.

Use it to understand intent, then challenge its architecture.

---

# Current architectural hypotheses

These are **hypotheses, not requirements**.

Do not allow their names or boundaries to bias the design prematurely.

I currently suspect there may be roughly:

```text
Effect-native FFI machinery
          ↓
Effect-native tls-client
          ↓
browser-like abstraction
```

But this may be wrong.

Part of the grilling is determining whether these are actually distinct abstractions.

---

# Hypothesis: generic Effect FFI

There may be a useful reusable abstraction underneath the tls-client integration.

For example, perhaps an Effect-oriented FFI abstraction could describe:

- native library location;
- exported symbols/functions;
- input/output schemas;
- serialization;
- platform/runtime-specific loading;
- initialization;
- resource cleanup;
- native memory ownership;
- errors;

and produce a properly typed Effect Service/Layer.

Conceptually something like `effect-ffi`.

It should ideally allow the higher-level library to work with both:

- `@effect/platform-node`
- `@effect/platform-bun`

But **do not assume this abstraction deserves to exist**.

Determine:

- what Node should use for FFI;
- what Bun should use for FFI;
- how different their semantics actually are;
- whether a small internal runtime abstraction is sufficient;
- whether Schema-driven FFI definitions are useful;
- whether this would genuinely be reusable;
- or whether extracting/generalizing it would just be premature abstraction.

Even if we conclude that `effect-ffi` is legitimate, keep it internal initially unless there is a strong concrete reason not to.

---

# Hypothesis: TlsClient / TlsSession

The native library appears to have persistent session state, connection pools, cookie jars, TLS configuration, proxies, etc.

Determine whether the Effect API should distinguish concepts such as:

```text
TlsClient
TlsSession
HttpClient
```

or something different.

Important questions include:

- What owns a native session?
- What should be scoped?
- Should `TlsSession` be acquired/released with `Effect.acquireRelease`?
- Should `Scope` destruction automatically call the native session destruction API?
- Is a session a Service, a value, or both?
- Is there a global native runtime/service underneath sessions?
- What configuration belongs to the Layer?
- What configuration belongs to a session?
- What configuration belongs to an individual request?
- Can sessions safely execute concurrent requests?
- How should native resource ownership be represented?
- How should cookies be exposed?
- How should proxy configuration be exposed?
- How should TLS/browser profiles be modeled?
- How should custom fingerprints be modeled?
- How should native errors become typed Effect errors?

Do not limit yourself to these questions.

---

# HttpClient integration

A major goal is to investigate implementing Effect's `HttpClient` abstraction.

Ideally an application could do something conceptually like:

```ts
program.pipe(
  Effect.provide(TlsHttpClient.layer(...))
)
```

and code written against `HttpClient` would transparently use `tls-client`.

But investigate the actual `@effect/platform` APIs before deciding this is correct.

Determine:

- what implementing `HttpClient` actually requires;
- request mapping;
- response mapping;
- headers;
- redirects;
- cookies;
- streaming bodies;
- streaming responses;
- cancellation/interruption;
- scopes;
- errors;
- tracing;
- request preprocessing;
- any assumptions made by Effect's existing Node/Bun implementations.

Identify capabilities that cannot be represented faithfully through `HttpClient`.

We may need both:

```text
TlsClient      → complete tls-client-specific API
TlsHttpClient  → HttpClient-compatible projection
```

but this is not predetermined.

---

# Non-HTTP capabilities

Do not force every tls-client capability through `HttpClient`.

Research things such as:

- WebSockets;
- bandwidth tracking;
- protocol information;
- streaming;
- persistent sessions;
- cookie state;
- connection lifecycle;
- other native capabilities you discover.

Then determine the most idiomatic Effect representation.

Possible Effect primitives might include:

- Service;
- Layer;
- Scope;
- Stream;
- Sink;
- Queue;
- PubSub;
- Channel;
- Socket/WebSocket abstractions from `@effect/platform`;
- Metric;
- Schedule;

but use them only where their semantics actually fit.

For WebSockets specifically, investigate the current upstream Go implementation and the CFFI work from #240/#251.

If supporting WebSockets requires an upstream contribution or temporary native patch, treat that as a separate architectural decision.

---

# Native FFI semantics

Spend particular attention on the native boundary.

I want the public API to make native implementation details essentially disappear.

Investigate:

- synchronous vs asynchronous FFI calls;
- whether calls block the Node/Bun event loop;
- Effect interruption;
- cancellation;
- thread safety;
- native concurrency;
- pointer lifetime;
- copying;
- `freeMemory`;
- JSON serialization overhead;
- binary data;
- streaming;
- crashes/panics/native failures;
- dynamic-library loading failures;
- process shutdown;
- session cleanup;
- whether finalizers can reliably clean resources.

For example, if the native ABI returns allocated strings that require `freeMemory`, users of the Effect API should ideally never be able to leak them accidentally.

Determine how much of this can be encoded into the internal Effect FFI abstraction.

---

# Native library distribution

Determine the cleanest strategy for getting the appropriate tls-client shared library onto the user's machine.

Research how upstream examples and `tls-client-node` solve this.

Grill decisions such as:

- download during install vs first use;
- package native binaries vs download them;
- cache location;
- version pinning;
- checksums/integrity;
- supported OS/architectures;
- libc differences;
- offline environments;
- CI;
- optional explicit library paths;
- native tls-client version vs npm package version;
- upgrade strategy.

Do not overengineer this if the existing upstream distribution model already solves most of it.

---

# Browser abstraction

Eventually I may want a higher-level browser-like abstraction inspired by:

`/Users/yovanoc/projects/slicethepie/src/browser`

The goal would be browser-like navigation/session semantics without launching Chromium when JavaScript execution/full browser automation is unnecessary.

Potential concepts might include:

- browser identity/profile;
- fingerprinted HTTP;
- persistent cookies;
- navigation;
- redirects;
- document/DOM parsing;
- DOM/environment mocks;
- browser session;
- WebSockets;
- bandwidth/events.

Maybe this deserves something like:

```text
Browser
BrowserSession
BrowserSandbox
```

Maybe it does not.

Determine what belongs in:

```text
tls-client transport
```

versus:

```text
browser semantics
```

versus:

```text
application-specific code
```

Do not generalize my slicethepie POC simply because an abstraction can be imagined.

---

# Packaging constraint

Do **not** prematurely create:

```text
effect-ffi
effect-tls-client
effect-browser
```

as separate repositories/packages.

Initially I expect **one open-source repository**, probably `effect-tls-client`.

If reusable abstractions emerge, keep them internal while we prove them.

Extraction should happen only when there is a concrete reason and a stable abstraction.

Avoid speculative framework-building.

At the same time, keep internal boundaries clean enough that extraction later would not require rewriting everything.

---

# Effect version

This project targets the current Effect beta APIs I'm using (`effect@beta` / corresponding current `@effect/platform-*` packages).

Research the **actual current APIs** instead of assuming stable Effect v3 APIs or relying on outdated examples.

Pay particular attention to current:

- Service patterns;
- Layer;
- Scope;
- Schema;
- HttpClient;
- Socket/WebSocket APIs;
- Stream;
- runtime/platform abstractions.

---

# Decision tree to resolve

The grilling should eventually resolve at least:

- exact project scope;
- supported runtimes;
- supported platforms/architectures;
- native library acquisition;
- native library versioning;
- FFI runtime architecture;
- whether a generic Effect FFI abstraction is justified;
- CFFI type/schema model;
- native memory management;
- native error model;
- interruption/cancellation semantics;
- concurrency semantics;
- session ownership/lifecycle;
- Service/Layer structure;
- request/session/global configuration boundaries;
- TLS/browser profile API;
- cookie API;
- proxy API;
- low-level `TlsClient` API;
- `HttpClient` integration;
- request/response streaming;
- WebSocket strategy;
- bandwidth/events/metrics strategy;
- browser abstraction boundary;
- Node vs Bun differences;
- testing strategy;
- testing against the actual native library;
- repository/package structure;
- tooling;
- CI;
- release/versioning;
- npm publishing;
- documentation/examples.

This list is not exhaustive. Add decision branches when research uncovers important issues.

---

# Desired outcome

Do not implement the project during the grilling.

Maintain a coherent record of the decisions we make.

Once the important branches are resolved, produce a concise architecture proposal showing the resulting layers and ownership model, for example:

```text
Application
     │
Effect HttpClient / Browser API
     │
tls-client Effect services
     │
internal FFI abstraction
     │
Node/Bun native loader
     │
tls-client shared library
```

but derive the actual architecture from the grilling rather than assuming this example is correct.

The final design should make clear:

- public APIs;
- internal APIs;
- Services;
- Layers;
- scoped resources;
- ownership/lifetimes;
- runtime-specific pieces;
- package/module boundaries;
- native boundary;
- capability mapping;
- future extension points.

Only after we agree on that architecture should implementation planning begin.

Start by researching the repositories, local POC, current Effect APIs, and upstream CFFI surface sufficiently to identify the **highest-leverage unresolved architectural decision**.

Then begin the grilling with that single question.
