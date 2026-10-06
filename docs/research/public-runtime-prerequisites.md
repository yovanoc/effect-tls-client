# Public runtime prerequisites and support audit

Documentation-only packet `OUTCOME573`, repository baseline `fbcddaa`.
This is a bounded comparison of published platform support and explicitly named
standard environment requirements, not a challenge implementation investigation.

## Starting evidence and limits

The coordinator reports that both latest root measurements still ended in
HTTP 403 after validated microtask, document-lifecycle, and narrow CT-script
allowance work. DataDome document evaluation succeeded in approximately 600 ms
with one network script, no reported cookie-set operation, and no Jar delta. Cloudflare
reported successful evaluation over 25 seconds with one network script and five
cookie-setter attempts, but no clearance cookie. These are supplied observations,
not independently reproduced here; their cause remains **UNKNOWN**. Successful
evaluation or a setter attempt is not vendor verification or authoritative
accepted cookie state.

Only public first-party documentation prose was used. No live target, challenge
HTML, SDK, script asset, private configuration, private error/trace, or acquisition
protocol was requested or inspected. No diagnostic inventory, cookie value,
nonce, source hash, or program flag is retained. The historical acquisition and
private-diagnostic lanes remain paused. Real renderers/browsers, human interaction,
CAPTCHA solving, hardware fabrication, proxy rotation, and private SDK inspection
remain outside this packet.

## Six cited claims and finite comparisons

1. **Cloudflare documents browser support, not a Node VM support contract.**
   [Supported browsers, “Browser support” and “Unsupported environments”](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
   says challenges support major desktop/mobile browsers; custom or heavily
   modified engines and embedded browsers have limited support. It excludes
   Internet Explorer, command-line tools lacking the required JavaScript
   capabilities, and automated browsers/frameworks for production solves.
   **Comparison:** [BrowserMock's documented contract](../browser.md#challenge-and-script-boundary)
   is a process-backed source VM with bounded browser-shaped subsets, not an
   actual browser. The cited page does not name Node VM specifically or certify
   it. A Chrome transport Profile or matching User-Agent does not place that VM
   within the published browser support promise. This is a support boundary,
   not proof that every unsupported runtime is impossible or the present cause.

2. **Cloudflare explicitly requires JavaScript and cookies; blocked scripts are
   a documented troubleshooting concern.**
   [Resolve a Challenge](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/resolve-challenge/)
   says visitors “must enable JavaScript and cookies” to pass any Challenge.
   [Challenge solve issues, “Challenge loops,” “Troubleshooting,” and “WebView and mobile app implementations”](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)
   identifies scripts blocked by settings/extensions and disabled JavaScript;
   its WebView-specific guidance additionally names missing DOM storage/cookie
   support, blocked service access, and a changing User-Agent.
   **Comparison:** [explicit document-script execution](../browser.md#explicit-response-document-script-evaluation)
   and [Go-owned script cookies](../browser.md#caller-reviewed-classic-root-source)
   already implement the JavaScript/cookie baseline in a limited model. Writes
   synchronize asynchronously and may be rejected by Jar rules. Network access
   remains deliberately policy-gated. The WebView guidance is scoped to actual
   WebViews, not a universal requirement to add DOM storage or another origin to
   this VM. The supplied measurements identify neither a blocked required
   resource nor a cookie-policy error; no policy expansion follows.

3. **Cloudflare warns against modifying browser APIs; it does not prescribe a
   shim inventory.**
   [How Challenges work, “Limitations”](https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/#limitations)
   says Challenges cannot support browser extensions that modify User-Agent or
   Web APIs such as Canvas and WebGL.
   **Comparison:** the [documented VM](../browser.md#caller-created-ordinary-elements)
   does not provide rendering or canvas elements and does not synthesize hardware
   properties. The warning concerns extensions modifying browser behavior; it
   does not specify the required Canvas/WebGL operations, establish that this
   root used either API, or authorize fabricated results. No renderer, hardware,
   trusted-event, or guessed getter proposal is justified by this passage.

4. **DataDome's Device Check support promise is conditional on integration and
   targets browsers/mobile apps.**
   [Device Check, “How does Device Check work?” and “Is Device Check compatible with any device?”](https://docs.datadome.co/docs/device-check)
   describes web/mobile browsers and mobile apps and says compatibility depends
   on correct integration. It specifically requires the JavaScript Tag on pages
   originating protected XHR/fetch requests. Its browser list names Chrome,
   Firefox, Edge, Opera, Yandex, and Safari with minimum versions. The
   [legacy-browser announcement](https://docs.datadome.co/changelog/end-of-support-for-legacy-browsers-july-1-2025)
   removes Internet Explorer 11 and Safari 11 and earlier for Device Check/CAPTCHA
   from July 1, 2025, despite the Device Check page still listing Safari 11.
   **Comparison:** [BrowserMock](../browser.md#challenge-and-script-boundary)
   is not a listed browser/mobile application integration. The supplied root
   observations do not establish the deployment's integration correctness or
   that the loaded script was Device Check. No Node VM compatibility promise,
   universal impossibility, or exact root cause follows from these statements.

5. **DataDome explicitly requires script-readable/writable cookies.**
   [JavaScript Tag, “Purpose” / “About the datadome cookie”](https://docs.datadome.co/docs/javascript-tag)
   says the Tag and response pages, including Device Check, require read/write
   access to the `datadome` cookie and warns against attribute tampering,
   especially `HttpOnly`.
   **Comparison:** the [documented cookie boundary](../browser.md#caller-reviewed-classic-root-source)
   exposes URL-filtered non-HttpOnly reads and raw writes through the authoritative
   Go Jar; protected HttpOnly/domain/path/secure rules are intentional, and writes
   flush before evaluation completes. [D10](../design/01-decisions.md#d10--cookies-go-jar-is-the-single-source-of-truth-exchanged-as-cookiescookies)
   and the [wire contract](../design/03-protocol.md#6-request--response) preserve
   that authority. This supplies baseline cookie capability, not full synchronous
   browser equivalence. The observations do not identify an HttpOnly conflict or
   rejected write reason; weakening cookie protections is not justified.

6. **DataDome publishes conditional CSP integration allowances, including a
   Blob-URL worker, but not a root-specific minimum API list.**
   [JavaScript Tag, “Content Security Policy,” “frame-src,” and “worker-src”](https://docs.datadome.co/docs/javascript-tag)
   says the CSP instructions apply when the corresponding directives or fallbacks
   are used. It documents response pages loaded in iframes and `worker-src blob:`
   to allow its web worker to load from Blob URLs, offloading fingerprint work.
   **Comparison:** [BrowserMock's documented subset](../browser.md#challenge-and-script-boundary)
   explicitly supplies neither workers nor object URLs; its
   [reviewed iframe path](../browser.md#experimental-reviewed-iframe-loading)
   is isolated and load-only, not SDK completion. The
   [current narrow script allowance](../browser.md#live-measurement-harness)
   is not a wildcard frame/worker grant. These are published integration-model
   differences, not evidence that the observed root required a worker or iframe,
   nor permission to expand execution or reproduce fingerprint behavior.

## Decision

**Evidence blocker: no identified root error.** The first-party prose establishes
support limits and a JavaScript/cookie baseline that is already implemented in
bounded form. It does not establish a missing, admissible standard API causing
either current HTTP 403. Published integration differences are necessary context,
not causal evidence or a promise that more shims can certify this source VM.

The cited prerequisite passages do not name WebAssembly as a requirement. The
[current documented runtime](../browser.md#caller-reviewed-classic-root-source)
intentionally disables WebAssembly code generation; do not turn an example
capability gap into a vendor requirement. Likewise,
[D21's synthetic lifecycle subset](../design/01-decisions.md#d21--explicit-root-document-script-lifecycle-subset)
is not SDK completion, and documentation does not justify a larger deadline,
Profile change, trusted events, fabricated hardware, or arbitrary browser APIs.

No implementation or new live packet is justified. Root should review this
finite evidence and retain **UNKNOWN**. A later documentation-only comparison
would need an explicit first-party prerequisite tied to an admissible environment
and a specific documented capability; it would still not establish causality or
reopen acquisition/private-diagnostic work.

## Read coverage and verification

Four varied public queries covered Cloudflare supported platforms,
JavaScript/cookie troubleshooting, DataDome Device Check environments, and Tag
integration prerequisites. Relevant passages were retrieved from seven canonical
first-party documentation pages and read directly, not inferred from search
summaries. Only support/prerequisite prose informs the six claims; installation
examples, SDK configuration, collection details, and linked assets were not used
as implementation evidence. No compatibility tool or linked runtime was run.
The Safari discrepancy is retained rather than silently choosing the stale list.

Local context read in full: global and repository `AGENTS.md`, current
`GLOSSARY.md`, both ADRs, `docs/design/01-decisions.md` including D21,
`docs/design/03-protocol.md`, all of `docs/browser.md` (including its continuation),
`datadome-public-domain-policy.md`, `public-protected-content-reference.md`, the
research and Effect skills, the installed Effect `AGENTS.md`, and the Ponytail
skill. Current `CONTEXT.md` is deleted in the working tree and could not be read;
it was not restored or substituted with a historical version. The replacement
user-added `GLOSSARY.md` was preserved. Only a targeted authored-library search
located the VM code-generation setting; no private program/SDK body was read.

`oxfmt --check docs/research/public-runtime-prerequisites.md`, `git diff --check`,
and the new-file `git diff --no-index --check` passed without formatting or
whitespace findings. Status showed only this new document beyond the pre-existing
user changes. No code, tests, live requests, commit, push, or external contact
was performed. Pre-existing user changes in `CONTEXT.md`, `GLOSSARY.md`,
`examples/basic-request.mjs`, `.pi/`, and `.cachebro/` remain untouched.
