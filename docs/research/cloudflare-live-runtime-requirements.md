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

## Authorized original-inline deny-host runtime diagnostic — actual execution

At **2026-10-01T08:18:01Z**, against published HEAD
`b65012b40de4b551eff168f8dc302997f4d66e02`, this newly authorized packet
performed **one page GET and one original-inline root evaluation**. It did
not repeat the earlier unadorned-script or empty/primitives-only gates.
The user's explicit provider-testing trust grant applied to the reviewed
original inline only; it did not authorize external SDK execution.

**Observed outcome: one actual dynamic script-load attempt reached the public
host seam and was denied before transport.** The root evaluation returned
without a reported runtime exception after the authored observation tail.
This is evidence of a reachable asset-loading path, **not** SDK compatibility,
readiness, successful acquisition, or clearance. No missing runtime feature
was added, and no protected-resource follow-up was made.

| Measurement                                            | Observed      |
| ------------------------------------------------------ | ------------- |
| Page GET count                                         | 1             |
| Page status / `cf-mitigated: challenge`                | 403 / present |
| Complete inspected page bytes                          | 6,070         |
| Selected original inline bytes                         | 3,663         |
| Static external script tags selected for counting only | 0             |
| Root JavaScript evaluations                            | 1             |
| Actual denied dynamic script requests                  | 1             |
| Actual denied fetch/XHR requests                       | 0             |
| Actual denied cookie-write attempts                    | 0             |
| External asset requests / external SDK executions      | 0 / 0         |
| Frame capability                                       | Absent        |
| Cookie values disclosed or retained                    | NONE          |

### Selection and in-memory operation review

The scoped selector reused the existing AWS scanner's bounded markup,
attribute, classic-type, raw-text, and script-closing semantics without
changing that scanner or any provider API. Its **separate probe assumption**
was scripting-enabled parsing: `NOSCRIPT` was skipped as raw text, including
any apparent script tags in its contents. This is not a full DOM/parser claim.
`base`, SVG/MathML, template, plaintext, ambiguous declarations/markup,
duplicate script attributes, nonclassic/module types, async/defer, and
unsupported/security script attributes remained rejected. Nonce, classic
`type`, `id`, and `data-*` metadata were accepted. Multiple inert external
script declarations could be counted but never fetched; exactly one original
inline slice was required, within 64 KiB.

Eight authored assertions passed before the live read: nonce/classic-type/data
metadata with multiple external declarations and inert NOSCRIPT contents
selected the exact authored source and correct count; module, duplicate
attributes, two inline programs, async, integrity, and base cases failed.
No vendor fixture was created.

The challenge marker was checked before source approval/execution. Node's
bundled **Acorn 8.16.0** parsed the complete current inline in memory. Every
AST node and every call target was traversed under the explicit trusted-inline
grant; the review was not limited to empty statements or primitive expressions.
The bounded program's assignments, object configuration, DOM member operations,
conditions, function bodies, and calls were inventoried without disclosing their
identifiers, keys, data, literal values, configuration, or URLs. Dynamic member
selection, unaccounted call targets/operations, eval/function code generation,
native-authority/private-binding access, prototype escape routes, and timer
string code would have stopped execution. Ordinary member/API labels were not
rejected merely because a runtime implementation might be missing. No generic
review framework, dependency, or reusable library was introduced.

Sanitized complete node inventory:
`Program=1`, `ExpressionStatement=10`, `CallExpression=9`,
`FunctionExpression=2`, `BlockStatement=3`, `AssignmentExpression=6`,
`MemberExpression=38`, `Identifier=81`, `ObjectExpression=1`, `Property=16`,
`Literal=35`, `VariableDeclaration=2`, `VariableDeclarator=2`,
`ConditionalExpression=2`, `LogicalExpression=3`, `BinaryExpression=8`,
`UnaryExpression=2`, `IfStatement=1`.
Call targets: **one IIFE, eight member calls, zero named local-function calls**.
Standard API labels only: `appendChild`, `createElement`,
`getElementsByTagName`, `replaceState`. These are static labels, not a claim
that every optional branch ran. History remained absent; no no-op History,
placeholder page script node, fake event, token, state, or message was supplied.

### Actual kernel and denied authority

Host and BrowserMock child used the exact executable
`~/Library/Application Support/fnm/node-versions/v25.9.0/installation/bin/node`,
reporting **v25.9.0**. The host alone used `--expose-internals` for its bundled
parser. BrowserMock preserved the original kernel and its child invocation
`--permission -e RUNNER_SOURCE`; no network grant was added. A separate authored
permission check with that exact executable reported network permission
**false**. The current source/ignored built runtime was used, not a substitute
VM or native browser.

The trusted facade was supplied directly at the public `BrowserScriptHost`
seam. Every `request` failed with the fixed typed `BrowserScriptError` reason
`probe-host-request-denied`, covering fetch/XHR and dynamic scripts;
`setCookie` failed with `probe-host-cookie-denied`; `loadFrame` was absent.
Host counters recorded only request-kind labels, never URLs. The actual script
attempt received no response body and no executable asset. There was no SDK
source review or SDK evaluation in this packet. Cookie state was read only from
the scoped Go Jar and passed as the existing root snapshot; guest writes were
all denied and no returned writes were applied to the Jar.

The original selected program was kept **unchanged as the exact source prefix**.
Only a minimal authored async tail waited **10 ms** through the existing timer
API before returning a fixed observation label. This kept the root alive for
bounded observation of asynchronous host attempts; it was not a fabricated
provider lifecycle event or a readiness/completion signal. Inline return/load
was never interpreted as clearance. No exception label was reported by this
actual root evaluation; the measured finding is the denied script-load count.

### Bounds, validation, privacy, and cleanup

The fresh scoped Browser/TlsClient used the existing static Go Bridge,
`chrome_152` and the project-derived Chrome152 Identity, no supplied
credentials/auth/proxy, no redirects/retries, and no challenge handler.
Limits remained **16 KiB response headers, 256 KiB streamed page inspection,
64 KiB source including the authored tail, 20-second HTTP timeout,
30-second request/body deadlines, 2-second BrowserMock timeout,
55-second Effect deadline, and 60-second probe watchdog**. The original
BrowserMock resource/IPC/timer/network limits were unchanged. The response was
explicitly closed, scopes released, and a subsequent process-name check found
no Bridge process remaining.

No vendor HTML/JS/configuration/nonce, cookie, private query, identifier,
source snippet, or vendor error text was printed or persisted. The live read
used the Bridge directly, not a content-cache/web retrieval tool. Only fixed
labels, counts, byte sizes, status/marker, and kernel metadata were emitted.
No native browser, CAPTCHA interaction, solver, proxy/rotation, identity
fabrication, external SDK execution, or automatic whole-HTML execution occurred.

Validation actually performed: Node syntax check of the authored probe; eight
selector assertions; active LSP checks clean for current BrowserMock and runner
source; the one live read/evaluation above; exact Node permission check; process
cleanup check. The temporary probe also received an auxiliary unchecked-call
finding for its top-level authored `assert.throws` fixture loop; no persistent
code was suppressed or altered. No build, broader tests, typecheck, lint,
CI rerun, or changes to runtime/source/tests were performed. Supplied exact
HEAD green CI remains historical evidence, not a new claim.

The only owned permanent change is this appended section. The authored temporary
`.cf-inline-runtime-probe.mjs` was removed and its absence verified. No pane,
workspace, worktree, or retained tab was created; no packet-owned resource
survives. Existing `examples/basic-request.mjs`, `.pi/`, and `.cachebro/` were
untouched; HEAD remained unchanged. All preceding notes are preserved.

## Authorized original SDK continuation — incomplete inline review/grant gate

At **2026-10-01T08:31:20.982Z**, against unchanged HEAD
`b65012b40de4b551eff168f8dc302997f4d66e02`, this packet reused the preceding
operator-target and bounded selector approach. The user explicitly authorized
execution of the original selected inline and its unique exact same-origin
Cloudflare bootstrap, with all subsequent authority denied. That authorization
was **not exercised**: the authored probe stopped before establishing its
inline AST/bootstrap grant. This is an **incomplete SDK diagnostic**, not an SDK
compatibility result, a clearance result, or evidence of a mandatory missing API.

| Measurement                                            | Observed                      |
| ------------------------------------------------------ | ----------------------------- |
| External page GETs                                     | 1                             |
| Page status / `cf-mitigated: challenge`                | 403 / present                 |
| Complete inspected page bytes                          | 6,006                         |
| Selected unchanged original inline bytes               | 3,599                         |
| External SDK GETs / inspected SDK bytes                | 0 / 0                         |
| Root evaluations / actual SDK executions               | 0 / 0                         |
| SDK attempted                                          | No                            |
| Denied script / fetch-XHR / frame / cookie-write calls | 0 / 0 / 0 / 0                 |
| Guest exception category / standard API label          | None observed / none observed |

### Concrete checkpoint and probe limitation

The scripting-enabled bounded selector selected one original inline slice,
accepting nonce/classic-type/id/data metadata and treating NOSCRIPT as inert raw
text. Seven authored selector assertions passed (one accepted case and six
rejection cases). The next synchronous boundary combined bundled-Acorn parsing,
whole-tree operation inventory, forbidden authority/code-generation/prototype
checks, computed-member checks, and selection of one literal directly assigned
to a script `src`. It did **not** return its inventory or exact-URL grant. The
probe retained only the fixed outer gate label, not the particular failed
subcondition; no completed AST review is claimed.

In particular, the authored inline guard rejected **every computed member**, not
just dynamic/private member selection. That is stricter than the preceding
packet: ordinary literal indexing can also be rejected. It is a probe limitation,
not proof that this live inline used such indexing or that any static/minified
label is semantically mandatory. With the page already discarded, this packet
cannot identify the exact failed subcondition. No second page read, weakened
live gate, or guessed/reconstructed challenge URL was used to recover it.

**Remaining work:** retain sanitized per-gate review outcomes in an authored
probe; distinguish reviewed literal indexing from unreviewed dynamic selection;
establish the exact original literal bootstrap grant; then inspect the complete
SDK in memory and deliver it once through the existing public script host path.
This packet did not inspect the SDK, complete its operation-safety review, or
measure its first real unsupported API/runtime error. No runtime feature was
added. No pending guest execution was observed because none began.

### Preserved bounds, authority, and privacy

The fresh scoped Browser/TlsClient used the existing static Go Bridge,
`chrome_152` with its project-derived identity and Go-owned default Jar, no
supplied credentials/auth/proxy, and no redirects/retries/challenge handler.
The page was streamed under **256 KiB**, with **16 KiB** response headers,
**20-second** HTTP timeout and **30-second** request/body deadline. The entire
probe used one **90-second** Effect scope/deadline. Its response was explicitly
closed and the enclosing session/Bridge scope released.

The unexercised SDK path was designed to select HTTPS, exact parent origin,
challenge-platform family, no credentials/fragment, and one complete original
URL retained in memory without query reconstruction. A second read would have
been bounded by **1 MiB minus inspected page bytes**. A reviewed response would
have reached `BrowserScriptHost.request` with kind `script`, then the existing
root dynamic-script evaluator. The **64 KiB** direct/root source ceiling was
unchanged and remains separate from the existing **1 MiB** dynamic asset/network
path; a large SDK was never offered as direct/root/frame input. No source-budget
bypass or cap increase occurred.

The authored, unexercised host denied all nonselected/additional requests,
fetch/XHR, frame loads, and cookie writes before transport using fixed typed
`BrowserScriptError` reasons and standard-kind counters. It supplied no fake
nodes, lifecycle events, history, messages, tokens, success signals, worker,
rendering, native browser, CAPTCHA action, paid service, rotation, or proxy.
Root request/timer/AES/document/attribute/frame ceilings, default **2-second** VM
limit, and existing **5-second** handler deadline were not modified. Its planned
250 ms authored observation tail was never evaluated. No cookie snapshot was
printed or interpreted as clearance; no protected-resource follow-up occurred.

Host executable was exactly
`~/Library/Application Support/fnm/node-versions/v25.9.0/installation/bin/node`,
reporting **v25.9.0**. The host used `--expose-internals` only for Node's bundled
Acorn; no dependency was installed. A separate exact-executable permission check
reported network permission **false**. BrowserMock's existing child invocation
remained `--permission -e RUNNER_SOURCE`; no child was spawned in this packet,
and no unsafe code-generation/native flags or host/source plugin was introduced.

Vendor HTML/JS/configuration/keys/literals/cookies/identifiers/private query
values/error text/source slices stayed off stdout and disk. Only fixed gate
labels, counts, sizes, status, time, and executable metadata were emitted.
Original selected source was untouched and never executed. Existing schemas,
runtime, tests, Go implementation, CI, Git state, dependencies, and protected
example were not edited.

Validation actually performed: authored Node syntax check; seven authored
selector assertions; one live page read; exact Node permission check; active
LSP probe of BrowserMock and runner. LSP reported **10 existing auxiliary
AST-grep findings** (including style/large-class/runtime-typeof findings), not a
clean-all-diagnostics result. No runtime-source edit or suppression was made.
No build, broader tests, typecheck, lint, or CI rerun was performed.

Only this section was appended by this packet, preserving all preceding notes.
The owned authored temporary `/tmp/effect-cf-sdk-146.mjs` was removed and its
absence verified. Post-scope process checks found no Bridge or packet probe
remaining. No pane/workspace/worktree/retained tab was created; no packet-owned
resource survives. Parallel provider-demo documentation and pre-existing
`examples/basic-request.mjs`, `.pi/`, and `.cachebro/` remained untouched.

A final active, error-severity LSP check of the same two unchanged runtime files
reported **zero errors**; this does not erase the auxiliary findings above.
The owned probe's absence was reverified after that check.

## Authorized task146 recovery — original SDK delivered; natural error marks an evaluation attempt

At **2026-10-01T08:41:05.627Z**, against unchanged HEAD
`b65012b40de4b551eff168f8dc302997f4d66e02`, the explicitly authorized recovery
used **two GETs**, bringing task146's campaign total to **three GETs** including
the preceding failed probe. The original selected inline ran and its original
runtime-selected SDK was delivered through the existing root dynamic-script
path **once**. A real script error event followed. **No clearance, readiness,
provider acquisition, or protected-resource success was demonstrated.**

| Measurement                                                    | Observed                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Recovery page / SDK GETs                                       | 1 / 1                                                                                                               |
| Page status / `cf-mitigated: challenge`                        | 403 / present                                                                                                       |
| Complete inspected page / original inline bytes                | 6,006 / 3,599                                                                                                       |
| SDK status / complete inspected SDK bytes                      | 200 / 238,361                                                                                                       |
| Aggregate recovery inspected network body bytes                | 244,367                                                                                                             |
| Root evaluations / SDK attempts                                | 1 / 1                                                                                                               |
| Reviewed-path SDK responses supplied                           | 1                                                                                                                   |
| SDK evaluation attempts                                        | 1, inferred from source delivery followed by the natural error; successful compilation or SDK entry not established |
| Natural script load / error events                             | 0 / 1                                                                                                               |
| Denied additional scripts / fetch-XHR / frames / cookie writes | 0 / 0 / 0 / 0                                                                                                       |
| Outcome                                                        | Real script error; not a pending deadline or compatibility pass                                                     |
| Sanitized load-rejection category                              | loader-rewrapped TypeError (non-diagnostic; underlying exception unknown)                                           |
| First underlying VM exception category / standard failing API  | Unknown / unknown                                                                                                   |

### What the runtime actually establishes

The caller's explicit execution grant covered this known operator challenge's
original inline and **one** known-provider bootstrap, not arbitrary origin-wide
code. The original inline selected the runtime request URL. The host required
GET, no body, HTTPS, exact parent origin, no credentials/fragment, and the
challenge-platform `orchestrate/chl_page/v<number>` bootstrap family. A unique
eligible original literal was also available and the complete runtime URL
matched it exactly. Query values and the full URL stayed unchanged in memory;
no URL/configuration guessing, reconstruction, or source rewriting occurred.
No other page scripts were selected or executed.

The selected asset GET occurred **inside `BrowserScriptHost.request` with kind
`script`**. Its original response body was returned through the existing
1 MiB network/asset response path, not direct/root/frame script input. The
unchanged runner executes a successful script response in the root VM before
resolving its loader promise. Its `run(message.response.body, context)` catch
converts a thrown VM exception into a failed reply; the realm then rejects the
request with `TypeError`, and the existing node loader dispatches a real error
event. There was one supplied successful asset response, no host-request failure,
and one natural error event. Source delivery followed by that natural error
proves an SDK evaluation attempt only; it does not establish successful
compilation or entry into SDK logic. No instrumentation or replacement of the
kernel/source was used.

The observer was an authored tail following the **unchanged original inline
prefix**, verified by a fixed guard. It attached additional listeners to the
**actual original-created script node**, did not replace the original handlers,
and waited for a natural load/error event or at most **250 ms**. It neither
created a node nor dispatched an event, message, lifecycle callback, readiness
signal, or acquisition signal. Only fixed event counters were returned through
the existing result schema. The error event won; it was not fabricated timeout
success.

**Error visibility limit:** the existing script-node error event carries no
underlying exception details, and the loader does not expose the original
caught VM exception through this public host seam. `TypeErrorunknown` describes
the loader's known rejection category, **not** proof that the SDK itself threw
TypeError. The first unsupported API and actual SDK exception category remain
unknown. No raw vendor error, stack, URL, identifier, or config echo was emitted.
No runtime feature was added to get past the failure.

### Operation inventory limitation discovered after execution

Acorn parsed the **complete original inline and complete original SDK** in
memory. The replacement reviewer did not prohibit callbacks, ordinary computed
members, literal numeric indexing, or literal string members. Its emitted inline
inventory included one literal numeric computed member, consistent with the
preceding probe's overly broad computed-member guard being unsuitable; the
preceding gate failure remains a **probe failure**, not VM incompatibility.

However, post-run inspection found another authored reviewer defect: its generic
visitor skipped the field named `value` for **all AST nodes**, not only literal
scalar values. That omits `Property.value` subtrees. Therefore the emitted
operation inventory was **partial**, despite complete parsing, and does **not**
satisfy the requested full SDK operation-safety inventory. It cannot establish
absence of native-authority/code-generation/prototype operations, or complete
call coverage. Counts or recognized static API labels are not mandatory semantic
capability proof. This defect is explicitly retained rather than presented as a
completed safety review.

Partial SDK inventory counters, solely for reproducible accounting of what the
probe emitted: **5,756 calls** (3,679 named / 2,066 member / 11 other), **29
constructors**, **2,907 assignments**, **566 updates**, **328 numeric computed
members**, **0 string computed members**, **4,365 other computed members**, and
**948 string literals**. These are not complete source totals. The inline's
emitted call/member counts were 9/38; its literal count was 19 versus 35 in the
preceding complete inline inventory, exposing the skipped property values.
Neither the partial inventory's zero static code-generation-site count nor its
standard `eval`/`Function` label occurrences establishes runtime invocation.

**Remaining limitation:** a complete operation inventory would require traversing
AST-valued `Property.value` fields, followed by a fresh authorized read because
the original live sources were discarded. Identifying the first actual VM
exception also requires an explicitly authorized observation seam that preserves
sanitized exception classification; it is not available from this natural error
event alone. **No further recovery/retry was performed.** The source-delivery
and natural-error observation is complete; it establishes an evaluation attempt
only, not successful compilation or SDK entry. The requested full inventory and
first-API classification remain incomplete.

### Fixed guard accounting

Every invoked explicit guard used a fixed authored enum and incremented its
counter before checking. **No guard failed in the live recovery.** Actual
successful guard invocation counts were:

- Runtime/source: `exact-node=1`, `inline-source-budget=1`, `inline-parse=1`,
  `root-source-budget=1`, `original-prefix=1`.
- Transport/page: `external-get-budget=2`, `page-body-budget=1`, `page-url=1`,
  `challenge-marker=1`, `page-media=1`.
- Classic selector: `markup=21`, `declaration=1`, `parsing-context=15`,
  `raw-close=3`, `script-count=1`, `script-close=1`, `raw-script=1`,
  `attribute-syntax=1`, `attribute-duplicate=1`, `attribute-kind=1`,
  `classic-type=1`, `unique-inline=1`.
- Exact bootstrap grant: `script-method=1`, `script-body=1`,
  `script-url-parse=1`, `script-https=1`, `script-origin=1`,
  `script-credentials=1`, `script-fragment=1`, `script-bootstrap-family=1`,
  `script-original-literal-match=1`.
- Asset: `asset-body-budget=6`, `asset-status=1`, `asset-url=1`,
  `asset-media=1`, `sdk-parse=1`, `asset-text-budget=1`.

This accounts for actual checks, not proof that the authored inventory traversal
was correct. No private attribute/key/value or arbitrary API label was included.

### Unchanged bounds, denial authority, and cleanup

Fresh scoped Effect Browser/TlsClient, existing static Go Bridge, `chrome_152`
and its project-derived identity, default Go-owned Jar, no supplied auth,
credentials, proxy, redirects, retries, or challenge handler. Page/header bounds
were **256 KiB / 16 KiB**; the SDK body bound was **1 MiB minus page bytes**.
HTTP timeout **20 seconds**, each request/body **30 seconds**, enclosing single
Effect scope/deadline **90 seconds**. Both responses explicitly closed; all
scopes released. No third GET or protected-resource follow-up was made.

The direct/root source cap remained **64 KiB including the authored observer**;
the original SDK used the separate existing dynamic-asset path. Existing actor
caps remained requests 8, timers 64/fires 256, AES 64, document nodes 32,
attributes 16 KiB, frames 4, default VM 2 seconds, and handler 5 seconds.
After claiming the one selected bootstrap, the host denied every additional
script/fetch-XHR request, frame load, and cookie write before transport using
fixed typed reasons. No such follow-on host call occurred. Go alone retained
same-origin cookie authority; cookie presence was never treated as clearance.
No permissions, resource quotas, or source limits were raised.

Host and child used the exact **Node v25.9.0** executable at
`~/Library/Application Support/fnm/node-versions/v25.9.0/installation/bin/node`.
The host alone used `--expose-internals` for bundled Acorn. BrowserMock retained
`--permission -e RUNNER_SOURCE`, string/Wasm code generation disabled, private
binding cleanup, and the unchanged runtime. A separate exact-Node permission
check reported network permission **false**. No native browser, unsafe V8/native
flags, source plugin, fabricated history/fingerprint/config/nodes/events,
CAPTCHA action, solver, paid service, proxy, rotation, dependency, or Go change
was introduced.

Validation actually performed: authored Node syntax check; five authored
selector assertions; one authored computed-member inventory assertion; the
single live recovery above; exact Node permission check; active error-severity
LSP diagnostics on unchanged BrowserMock and runner with **zero errors**.
Earlier auxiliary findings remain as previously documented. No build, broader
suite, typecheck, lint, or CI rerun was performed.

Only this section was appended by this recovery; previous partial notes remain
unchanged. All vendor page/source/query/configuration/literal/key/cookie/ID/error
material remained in memory, without stdout/disk fixtures or captured payloads.
The owned authored `/tmp/effect-cf-sdk-146-retry.mjs` was removed and absence
verified. Post-scope process checks found **zero Bridge processes**. No owned
pane/workspace/worktree/retained tab was created or survives. Source/tests/Go,
CI, dependencies, Git HEAD, the protected example, parallel provider-demo note,
`.pi/`, and `.cachebro/` were untouched.

### Historical checkpoint: classic runtime probe (2026-10-01)

Working, uncommitted classic source against published Go Bridge `b650`; no claim
of publication or root-code clearance. Exact Node `v25.9.0`/bundled Acorn `8.16.0`,
`CGO=0`, Chrome `152`, matching profile identity and same Go-owned Jar. Source 7
hash unchanged; runtime gate not rerun.

- Two GETs: parent `403`, SDK `200`, both HTTP/2; challenge marker present. Page
  `6,070` bytes (original inline `3,663`, observer inline `4,469`); SDK `238,202`,
  aggregate `244,272`; elapsed `2,083 ms`.
- SDK callbacks/grants/delivery `1/1/1`; natural `LOAD/ERROR` `0/1`. These
  indicate evaluation attempts only, not successful compilation or SDK entry.
  Classification remains `UNKNOWN`/`NAME_UNKNOWN`/`API_UNKNOWN`.
- Follow-on script/fetch-XHR/frame/cookie-write calls `0`; each capability denied.
  Jar `false` before/after. No acquisition, clearance, protected follow-up, or retry.
- Original inline/SDK unchanged; caller-only observer, at most `250 ms` microtasks;
  no fabricated readiness/config/history/DOM/nodes/provider protocol. HTTP `20 s`,
  request `30 s`, parent `90 s`, handler `5 s`, default VM `2 s`, supported
  config/defaults unchanged; source `64 KiB`, aggregate assets `1 MiB`, headers
  `16 KiB` unchanged.
- Before traffic: 25 authored checks (selector 8, full-traversal AST 1,
  classifier 9, VM 7); authored frame fixture corrected before GET. Full in-memory
  Acorn inventory: `74,671` nodes, `6,407` calls, `30` constructors, `4,179`
  properties, `793` function-valued `Property.value`s, `2` class methods, `3,003`
  assignments, `569` updates, `5,024` computed members. Not a safety proof or
  mandatory runtime inference; does not revise the incomplete 146 AST traversal.
  Error-158 source-free fixture diagnosis remains outstanding; no source-fix claim
  or vendor/private material persisted.

### Current-runtime Cloudflare receipt (packet 204; source-free)

Packet 204 measured one bounded current-TS/runtime Cloudflare attempt on unchanged
TS source `d4838beb35e35e2fd6f6d06ade75e292c44f4a14`; no SDK/runtime code changed.
This is separate from historical packet 157's two-GET budget. Earlier Cloudflare
campaign totals are unknown; no combined total is inferred. The exact host was
Node `v25.9.0`. The child executable was requested/mock-configured as v25.9.0 at
the path in code, but its actual version was **not independently observed**.

| Measurement        | Packet 204 result                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Go transport       | Two Go GETs, both HTTP/2: page `403`, 6,070 body bytes / 2,065 header bytes; original selected SDK `200`, 241,146 body bytes / 263 header bytes. Aggregate body: 247,216 bytes.                                                                                                                                                                                                                                          |
| Original programs  | Original inline `3,663` bytes; root with unchanged authored observer `4,469` bytes. The inline remained a global classic program; the original SDK URL and SDK program remained unchanged on its own classic dynamic path. No SDK-source concatenation, config/URL reconstruction, or fabricated DOM, canvas, events, messages, history, or metrics.                                                                     |
| Attempt and result | Script callback / grant / delivery `1/1/1`; natural `LOAD/ERROR` `0/1`. Stop `NATURAL_SCRIPT_ERROR`, author phase `OBSERVED`, category `UNKNOWN`, API `API_UNKNOWN`. Delivery plus natural error supports only an **inferred evaluation attempt**; successful compilation and SDK entry are **not proved**. No next mandatory public API was identified; static AST references are not mandatory execution requirements. |
| Follow-on work     | Follow-on script / Fetch-XHR / frame / cookie-write callbacks `0/0/0/0`; no protected-resource follow-up, acquisition, or clearance. The acquisition-denied diagnostic is not a proof phase.                                                                                                                                                                                                                             |
| Cookie observation | `GO_JS_VISIBLE` was false before and after specifically for `browser.transport.scriptCookies(TARGET)`. This is not a full Go-Jar or `HttpOnly` snapshot and does not prove all cookies absent. Do not describe a full Jar as empty or claim fresh-token acquisition. Full acquired Go state/flush and protected non-challenge 2xx remain **UNPROVED**.                                                                   |
| Limits and elapsed | Existing VM timeout 5s, HTTP 20s, request 30s, parent 90s, shared network 1 MiB, initial source 64 KiB, page 256 KiB, headers 16 KiB, and max two GETs remained unchanged; guest code generation and permissions were not relaxed. Reported elapsed time 1 second; exit 0; scope closed; owned probe-shell survivors 0.                                                                                                  |
| Bridge identity    | `CGO_ENABLED=0`; Bridge `0.1.0`, tls-client `1.16.0`, Go `1.27.1`, protocol `1`. `packages/bridge-darwin-arm64/bin/bridge` and `bridge/bridge` had main SHA-256 `002bab99cccc76182ad3115835cbd419857bbf561849791b49801766328abd00`. Go source was historical `b65012b`; TS source was `d4838...`. The binary identity does not establish the independently unobserved child version.                                     |

The CLI `--live` path first passed its offline authored fixtures (8 selector, 1
AST, 9 classifier, 7 VM); these are not provider proof. Recovery was packet 196
partial, packet 200's public parser dependency, packet 201 regeneration from the
original packet 157 author command after reading unchanged public source
(344/b650/TS d4838), and packet 202's stale fixtures corrected in 203. No SDK or
runtime change followed. AST inventory is now optional diagnostic data with
`complete: false` on parse exception; mandatory asset status, URL, media, UTF-8,
aggregate-size, and source-authorization guards remain. Generic node error reason
is still discarded, preserving `UNKNOWN`; no private-error channel/backchannel
or task 162/194 refusal reroute was added (both remain paused). The retained
authored Cloudflare probe remains available for future work and was not removed.
No vendor source/HTML/configuration, private URL/query, cookie, or raw error was
persisted.
