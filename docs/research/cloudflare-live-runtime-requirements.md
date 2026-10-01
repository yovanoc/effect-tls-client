# Cloudflare live runtime requirements — bounded read-only map

## Result and provenance

**Not clearance, not a solver implementation.** Current source HEAD: `e24310a`.
The authorized practice target remains
<https://www.scrapingcourse.com/cloudflare-challenge>. Its first-party
[index](https://www.scrapingcourse.com/) explicitly lists “demo Websites/Pages
to scrape” and “Cloudflare Challenge — Bypass the Cloudflare challenge.” This
public operator evidence was read before the target requests. It does not grant
permission to probe other sites or undisclosed endpoints.

Live inspection started **2026-10-01T06:07:38.761Z**, finished in **320 ms**.
Exactly **2 target requests**, both GET; **0 JavaScript executions**, no
redirects, retries, POSTs, frame requests, or protected-resource follow-up.

| Read                                                          | Status / protocol | Media type             | Complete inspected body bytes |
| ------------------------------------------------------------- | ----------------- | ---------------------- | ----------------------------: |
| Practice challenge document                                   | 403 / HTTP/2      | text/html              |                         6,049 |
| One explicitly declared same-origin challenge bootstrap asset | 200 / HTTP/2      | application/javascript |                       243,467 |
| Total                                                         | 2 requests        |                        |                       249,516 |

The page had the documented challenge response marker; its inline configuration
contained a managed challenge type literal. Neither the asset's 200 nor its lack
of a challenge marker means the protected document was cleared. One inline
script was present, measuring **3,642 bytes**. Exactly one eligible literal
bootstrap URL was found in page-declared script source metadata. The asset had
three lines and was likely minified. No optional third request was necessary:
there was no conservatively selected frame document to inspect without executing
or reconstructing JavaScript.

### Transport, bounds, and retention

Used the existing built `Browser.open` and `TlsClient.layer` with NodeServices,
a fresh scoped session, and **`chrome_152` with its profile-derived Chrome152
Identity**. Requested manually through `browser.transport.request`, not
`navigate`, a handler, or BrowserMock; Go retained Jar authority. Request-kind
headers were supplied without altering the fixed identity/profile. No manually
supplied credentials or cookies, no proxy, no certificate-policy changes.

HTTP timeout: **20 seconds**; each read: **30 seconds**; enclosing packet probe:
**90 seconds**. Transport response header limit: **16 KiB**. Page inspection:
**256 KiB**. Asset inspection: at most **1 MiB**, additionally reduced by the
already consumed page bytes so the two reads shared **1 MiB aggregate**. Stream
chunks were counted before accumulation; failure would terminate inspection and
close the response. Both reads completed below their limits. Both responses
were explicitly closed and their nested scopes released; the enclosing session
and Bridge scope were released. A subsequent process-list check found no Bridge
process remaining.

The bootstrap read grant required a unique literal page-declared URL, HTTPS,
exact target origin, challenge-platform path family, and no URL credentials or
fragment. The original URL was retained unchanged in memory, including its query;
no endpoint guessing, query reconstruction/reordering, or forced source fetching.
The read grant was **not** JavaScript execution authorization.

Vendor HTML, JavaScript, URLs containing private queries, headers, cookies,
configuration, and identifiers were never printed, archived, or written to disk.
The extractor ran from authored stdin; no temporary source file or fixture was
created. Only counts, statuses, media types, timings, and predefined standard-API
labels were output. Public documentation retrieval was separate from these two
target reads; the live target/asset did not use a caching content-fetch tool.

## What can actually be inferred

Evidence levels are intentionally separate:

- **Observed response metadata:** the two responses and sizes above.
- **Static page references:** `document.createElement`, `getElementsByTagName`,
  and `history.replaceState` occur in the inline bootstrap. This identifies
  bootstrap compatibility requirements, not an executed trace or unconditional
  call order. It declares the selected external asset through literal source
  assignment.
- **Static asset references:** `DOMContentLoaded`, `XMLHttpRequest`,
  `addEventListener`, `Worker`, `Blob`, `setTimeout`, and `setInterval` occur in
  the selected minified asset. Text occurrence does not prove invocation,
  constructor use, mandatory execution, or even a reachable branch.
- **Unknown:** asset semantic call graph, branch conditions, frame URL selection,
  worker program, rendering requirements, challenge exchanges, completion
  signals, and acquisition protocol. No deobfuscation or execution was performed.
  Absence of other literal API labels does not establish their absence from the
  program; computed names/string tables defeat this inspection.

Sanitized lifecycle map:

1. Protected navigation receives managed challenge HTML instead of the resource.
2. Page-owned inline bootstrap configures challenge state and declares a
   same-origin external script. Static bootstrap references include script-node
   creation, document script lookup, and History replacement.
3. The selected external script loads; lifecycle/network/worker/timer labels are
   present, but downstream sequencing is **unknown**.
4. Cloudflare's public contract says a successful challenge grants clearance
   state and permits the original resource request. This stage was **not reached**.

These are not instructions for a private challenge RPC. Managed challenge
internals are private/unstable; the consulted public docs publish no managed
challenge acquisition API or iframe success-message contract. Turnstile's public
`render`, `execute`, callbacks, and `getResponse` concern a configured Turnstile
widget, not an interchangeable managed-page `getToken` endpoint. No fabricated
messages, bodies, tokens, or completion callbacks are proposed.

## Three first capability gaps to investigate in our runtime

These are concrete source gaps, ordered by bootstrap/lifecycle proximity rather
than claiming a measured exception order. Whether every reference is mandatory
still requires an explicitly reviewed execution packet, which is outside this
read-only map.

| Capability                            | Live static evidence                    | Current owned implementation / blocker                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script-node lookup against the page   | Inline `getElementsByTagName` reference | At published HEAD `e24310a`, before the uncommitted modeled lookup, Runner had frozen `head`/`body` append targets and bounded script/iframe nodes, but no `getElementsByTagName` lookup. It could not locate the page's existing script node or provide browser lookup semantics in that historical source state. A reachable call would fail; returning an invented node would hide the gap. |
| Same-document History replacement     | Inline `history.replaceState` reference | Runner exposes a frozen location snapshot and no History object. It cannot replace the current same-document history URL. A reachable call fails; a no-op would falsely claim a browser state transition. No navigation or cross-origin grant follows from this requirement.                                                                                                                   |
| Document readiness/lifecycle delivery | Asset `DOMContentLoaded` reference      | Runner supports document/window listeners and synthetic Events, but has no automatic document parsing/readiness or lifecycle event delivery. An event-dependent path can stall even when listener registration succeeds. Dispatching an arbitrary “ready” event is not evidence the managed bootstrap completed. Mandatory use is unproven in the minified asset.                              |

Source: `packages/effect-tls-client/src/browser/BrowserScriptRunner.ts`,
especially its document/location construction, external script nodes, frame
facade, and `createRealm`/`start`; `docs/browser.md` documents no DOM tree or
automatic lifecycle delivery. Existing tests establish synthetic Event and
isolated load-only frame behavior, not managed challenge compatibility.

### Size is a real routing distinction, not an invitation to raise a cap

The **243,467-byte asset exceeds 64 KiB**. Passing its whole source to
`runBoundedScript`/`BrowserMock.evaluate` or selecting it as reviewed child-frame
source is disallowed. The 3,642-byte inline bootstrap fits that limit.

Important current-source distinction: `BrowserScript.ts` bounds direct source
at 64 KiB, and Browser/BrowserMock aggregate **root plus reviewed frame-selected
source** under that ceiling. However, the root dynamic-script response path in
`Browser.ts` and `BrowserMock.ts` accepts assets up to 1 MiB; the runner's
`handleParentLine` executes successful script responses without adding their
source bytes to the root/frame selected-source counter. Thus “all downloaded
parent scripts share the 64 KiB source cap” is **not what this HEAD currently
enforces**. The live asset is below the existing dynamic asset/network limits;
its size alone does not prove that specific loading path fails. No bypass,
chunking, rewritten asset, or cap increase is recommended. Any next packet must
settle this authority/accounting distinction explicitly, not silently broaden
what a source-selection review authorizes.

### Other unsupported paths: explicit stops, not established prerequisites

- **Worker:** a live static label is present; Worker is absent from the runner
  and existing Blob tests assert its absence. Blob itself is implemented in a
  bounded subset. No conclusion that worker execution is mandatory follows from
  these two words. If mandatory, stop rather than replace it with fake success.
- **Frames:** only reviewed selected source executes in separate V8 realms;
  frame content windows remain opaque. Child network, dynamic script loading,
  cookie writes, navigation, nested frames, and `postMessage` are unsupported.
  The live read did not establish a particular frame or messaging requirement.
- **Security attributes / rendering:** script integrity/crossorigin/module/defer
  handling and most frame security attributes fail explicitly; no renderer,
  canvas/SVG/layout, or trusted input delivery is supplied. If a reviewed path
  requires these, stop. Do not ignore security attributes or synthesize metrics.
- **Existing support is not clearance:** parent fetch/async XHR, timers, event
  listeners, URL helpers, Blob/FileReader/FormData, TextEncoder, secure randomness,
  and restricted AES-GCM already exist. Their presence does not prove private
  provider compatibility. Do not reimplement them speculatively.

Keep source review, Schema validation, frame ownership/routing, and exact-origin
network grants distinct. Preserve root-private-binding removal, separate child
intrinsics, 32 nodes, 16 KiB attribute budget, 4 frames, 64 live timers/256 fires,
64 AES operations, 8 network requests/1 MiB aggregate, the 5-second whole-handler
deadline, and VM default 2 seconds/configured 1–120 seconds. Network authority
does not confer renderer, child transport, or provider protocol authority.

## Historical small next-packet proposal — owned bootstrap compatibility, not a solver

**Historical proposal only; no implementation in that packet.** This proposal was
based on published HEAD `e24310a`, before the uncommitted modeled
`getElementsByTagName` lookup, and is not a current gap assessment. At that time,
the proposed packet was limited to bounded script-element lookup, addressing the
earliest document-model gap without introducing a general DOM, lifecycle engine,
or challenge adapter.

Owned files:

- `packages/effect-tls-client/src/browser/BrowserScriptRunner.ts`
- `packages/effect-tls-client/tests/browser.test.ts`
- `docs/browser.md`

Acceptance uses entirely authored synthetic source: create two existing bounded
script nodes, query the script collection, append a third, and verify documented
lookup ordering/collection semantics and absent-node behavior. Verify that lookup
adds no automatic script execution/network grant, cannot expose private bindings
or cross-frame objects, and cannot escape the existing node/attribute budgets.
Unsupported element types and security attributes must still fail. No vendor
HTML/JavaScript/payload fixture or captured identifier is allowed. Keep History
and lifecycle work in separate packets; a lookup test passing is not Cloudflare
clearance. Before any later live execution, review the complete selected source
and resolve the dynamic source-budget distinction above; this map does not
supply that approval.

## What distinguishes genuine clearance from a close false positive

A future claim needs **both** legitimate acquired state retained by the same
Go-owned Jar and a same-session GET to this protected route returning expected
non-challenge content with a 2xx status. Keep the same Profile/Identity/session;
no planting imported cookies or swapping transport. Record only sanitized
state-presence/change evidence, not cookie values. Inspect content semantics and
the documented challenge marker, not just status.

An asset/frame 200, VM success, load event, synthetic message, dummy Turnstile
token, callback invocation, cookie-shaped string, handler retry decision, or
cookie presence alone is insufficient. A generic 2xx page unrelated to the
protected resource is also insufficient. A generic 403 without the marker is
not necessarily this challenge. **We have neither legitimate acquired clearance
proof nor a protected non-challenge 2xx follow-up yet.** Public browser-support
guidance also excludes automated production challenge solving; implementing
standard APIs cannot promise provider acceptance.

## Primary public sources

1. [Operator practice index](https://www.scrapingcourse.com/): explicit demo listing and selected challenge route.
2. [Interstitial Challenge Pages](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/): managed challenges dynamically select checks/interaction; successful verification permits the destination request.
3. [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/): authoritative challenge marker, not status inference.
4. [Challenge Passage](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/challenge-passage/): successful challenge sets clearance state; later access evaluates it.
5. [Clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/): challenge clearance versus Turnstile token, optional pre-clearance, visitor/device binding and possible later re-challenge.
6. [Turnstile client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/): public widget lifecycle, callbacks and `getResponse`; not a managed challenge API.
7. [Turnstile CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/): scripts/iframes, nonce propagation and same-origin pre-clearance connection requirement; no published iframe acquisition protocol.
8. [Supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/): modified engines have limited support; automated production solving is unsupported.
9. [Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/): dummy widget behavior is not live managed-challenge clearance.

## Validation and change boundary

Read-only inspection of current source, nearby frame/Blob tests, package setup,
protocol and ADRs; live bounded transport reads as recorded above. Environment:
Bun workspace, Effect `4.0.0-rc.116`, strict TypeScript, Vitest/@effect/vitest,
Oxlint with Effect plugin, Oxfmt, and configured effect-tsgo. Probe host Node
`v26.10.0`. No source/API changes, LSP diagnostic run, test run, build, package
installation, or CI edits were needed or performed; prior green CI is supplied
context, not newly verified evidence. Mandatory Effect/effect-ts skills were read
and Ponytail loaded/active; configured reference descriptions and available
repository introductions were inspected, with canonical Scope source consulted
for scoped cleanup. Application references do not specify Cloudflare internals.

Only this new document is owned. Existing provider-demo notes, example changes,
`.pi`, and `.cachebro` remain untouched. No pane/worktree/retained tab or temporary
probe file was created.

## Restricted inline-only execution packet — pre-execution stop

At **2026-10-01T06:35:08Z**, this packet stopped without source approval.
**No current target GET, asset GET, guest evaluation, or challenge exchange was
performed.** Thus there is no new response status, runtime exception, asset-load
attempt, lookup branch proof, token, or clearance evidence. The earlier operator
practice-index evidence above remains historical; it was not re-fetched here.

The exact installed executable at
`~/Library/Application Support/fnm/node-versions/v25.9.0/installation/bin/node`
reported **v25.9.0** and, under `--permission`, reported network permission
**denied**. This was an authored capability check, not a guest evaluation or a
BrowserMock integration check. Node 26 was not used to prove the required kernel
behavior. The available working-tree runner source contains
`document.getElementsByTagName` with cached modeled head/body/attached-script
collections; no build or use of the older dist runner was performed. HEAD remains
`e24310a`; the existing uncommitted lookup implementation was only read.

### Gate that was not satisfied

The execution grant requires complete in-memory review of the **actual current**
unique inline program before evaluation. No current program was fetched or
reviewed. The available direct source-inspection tools return inspected text to
the conversation; this packet also forbids output or persistence of vendor
HTML/JavaScript and private values. I did not establish a private full-source
review path within those constraints. A source-size check, API-label inventory,
AST-node allowlist, or historical bootstrap description would not constitute
complete review of unknown active behavior. Consequently I did not approve
source, infer its current contents, or issue a speculative GET merely to count
bytes. This is a review-path limitation of this attempted packet, **not** evidence
that the program is hostile or that the public runtime lacks a host override.

### Public host boundary inspected, not exercised

Current `BrowserScript.ts` exposes `runBoundedScript(runtime, input, context,
host)`, and `BrowserMock.evaluate` accepts that `BrowserScriptHost` directly.
The host has `request`, `setCookie`, and optional `loadFrame`; script loads route
through `request` with kind `script`, as do fetch/XHR with kind `fetch`. A trusted
facade returning only typed `BrowserScriptError` failures can therefore deny
these capabilities without replacing provider source or returning executable
asset bodies. This inspection found **no public host-override gap**. It is not a
runnable deny-facade verification: no facade or guest kernel was instantiated.

The current runner's root wrapper finishes after the source result and cookie
flush; that alone does not establish completion of asynchronous external script
loads. Any later authorized probe must use observed outer host attempts rather
than interpret root completion as SDK execution or bootstrap compatibility.
No fake nodes, History methods, readiness events, frame messages, callbacks,
private URLs, cookies, or source rewrites were introduced here.

Only this section was appended. No tracked source/tests, other documentation,
manifest, permissions, profile, or configuration was changed. No temporary probe
script, pane, workspace, worktree, or retained tab was created; there are no
packet-owned survivors to clean up. No test, build, lint, or LSP diagnostics were
run. **Restricted live execution remains unperformed and unapproved.**

## Task133 bounded page READ — inline selection stop

This continuation made **exactly one target page GET** through the freshly built
Effect Browser/TlsClient and the existing static Go Bridge. It did not repeat the
practice-index research. The fresh scoped session used `chrome_152` and its
project-derived identity, no supplied credentials/proxy, no redirect following,
and no challenge handler. Bounds were 16 KiB response headers, 256 KiB streamed
page body, 20-second transport timeout, 30-second request/body deadlines, and a
60-second packet watchdog (55-second Effect deadline). No additional page,
asset, frame, SDK, or challenge exchange was requested.

**Concrete gate:** the in-memory extractor did not establish exactly one
unadorned inline script with exactly one script tag overall. Its intentionally
strict selection accepted only a script opening tag with no attributes; this
is an extraction limitation, not evidence that the actual program is hostile,
that no inline exists, or that the runtime lacks an API. The returned page was
not printed, retained, or re-fetched to relax that gate.

The exact installed Node **v25.9.0** exposed its bundled **Acorn 8.16.0** parser
without installation. A whole-tree fail-closed operation reviewer was available
in the authored probe, but **the selection gate stopped before AST parsing or
review of the live inline**. Consequently this packet does not claim complete
source review or execution approval. Merely counting AST nodes or recognizing
API labels would not establish semantic approval. The reviewer approved only
empty statements and primitive literal expressions; all other operations lacked
an approved bootstrap semantic rule and would have been rejected rather than
inferred safe. No vendor SDK was offered for review or execution.

Outcome distinctions:

- **READ:** one completed page GET, source/page evidence memory-only.
- **Approved original inline EXECUTION:** none; no guest evaluation.
- **SDK denial:** no load attempt occurred, hence zero observed denied loads;
  SDK execution remained prohibited, not tested by a live inline.
- **Clearance:** none; no clearance claim, acquired-state proof, or follow-up GET.

Validation: `bun run build` in `packages/effect-tls-client` passed and regenerated
ignored dist from the current uncommitted lookup implementation, not older dist.
No source/test edits, tests, lint, or LSP diagnostics were performed. The current
public host override seam was read; because execution was not approved, no
BrowserMock deny-host instance or guest kernel was run. No fake nodes, history,
events, state, cookies, CAPTCHA interaction, or provider-source rewriting was
introduced. Page/JS/config/nonce/cookie/query values were never printed or
persisted. Only this section was appended, preserving the previous stop note.
The authored `.task133-read.mjs` probe was removed and its absence verified.
No pane, workspace, worktree, or retained tab was created; ignored dist is the
explicitly permitted surviving build output.
