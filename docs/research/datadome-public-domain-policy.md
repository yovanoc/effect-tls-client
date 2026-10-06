# DataDome public domain-policy audit

Documentation-only packet `task564`, baseline HEAD `af2f57b`. Sources are public
DataDome documentation and its publisher-authored YesWeHack program rules.
No protected target, challenge document, script asset, configuration, or SDK
source was fetched or inspected; no browser, execution, proof request, acquisition,
CAPTCHA solving, or transport/policy change was performed.

## Starting boundary

The supplied observation is one `captcha-delivery.com`-hosted static asset in
the fixed Node.js bounty-root document, rejected as `RESOURCE_FAILURE` before
transport because its origin is not allowlisted. Its purpose remains **UNKNOWN**.
This audit does not rederive that observation from private material or retain its
URL. The documented local policy permits only the bounty-page origin,
`js.datadome.co`, and `api-js.datadome.co`, with no frame grants
([browser policy](../browser.md#live-measurement-harness)). Hostname spelling is
not evidence of human interaction.

## Six published role/scope facts

1. **Ordinary tag and signal-collection roles are published.** The
   [JavaScript Tag documentation, CSP `script-src` and `connect-src` sections](https://docs.datadome.co/docs/javascript-tag)
   says `js.datadome.co` allows loading the JavaScript Tag and
   `api-js.datadome.co` allows the tag to “send the fingerprint back to our API.”
   These are integration roles, not a guarantee that every request on either
   host is ordinary or that tag delivery proves protected-content access.

2. **A CAPTCHA-delivery hostname has a published script role, but not an
   exclusively interactive role.** The same
   [CSP `script-src` section](https://docs.datadome.co/docs/javascript-tag#script-src)
   explicitly names `ct.captcha-delivery.com`: it “will allow the scripts of our
   response pages to be loaded from this domain after a request has been
   blocked.” This establishes response-page script delivery. It does **not**
   identify an exact static pathname, label a particular script Device Check,
   or say whether that script participates in an interactive CAPTCHA.

3. **The published response-page serving family includes Device Check, CAPTCHA,
   and Block, not CAPTCHA alone.** DataDome's
   [required CSP change announcement](https://docs.datadome.co/changelog/change-needed-for-users-of-csp-directive-frame-src)
   describes “a new serving endpoint for response pages (Device Check, CAPTCHA,
   Block)” and replaces `frame-src geo.captcha-delivery.com` with
   `frame-src *.captcha-delivery.com`. The
   [latest reminder](https://docs.datadome.co/changelog/last-call-on-required-change-for-users-of-csp-directive-frame-src)
   repeats that replacement; the current
   [tag `frame-src` guidance](https://docs.datadome.co/docs/javascript-tag#frame-src)
   says it allows response pages to load in an iframe after a blocked request.
   This is a published family-level serving role, not a mapping of every
   subdomain/path to a response type or permission to load frames here.

4. **Device Check is explicitly automatic and non-interactive, with limits.**
   [“What is Device Check?”](https://docs.datadome.co/docs/device-check)
   defines it as “a verification process that runs on the end user’s device,
   without the need for any user interaction” and says it “acts like a CAPTCHA,
   without prompting any challenge to the end user.” Verification runs
   automatically; a bot can be blocked or additionally challenged. The
   “How does Device Check work?” section explicitly allows escalation to
   CAPTCHA. Its supported environments are web/mobile browsers and mobile
   apps; “invisible mode” only means no visual content is displayed. These
   statements establish non-interactive verification, **not** a no-CAPTCHA
   outcome, a renderer-free contract, or support for this project's VM.

5. **An interactive response type is documented separately.** The
   [DataDome Slider documentation, “What data is collected?”](https://docs.datadome.co/docs/datadome-captcha)
   includes “User interaction with the slider page and device dynamics,”
   including mouse, touch/scrolling, and keystroke dynamics. This contrasts with
   Device Check's explicit no-interaction definition. It supplies no rule for
   classifying the observed static asset from its hostname alone.

6. **Publisher scope includes supporting domains, subject to the program's
   qualification limits.** The
   [Bot Bounty policy, “Scopes” and “Important clarifications”](https://yeswehack.com/programs/datadome-bot-bounty),
   corroborated by the [public program rules API](https://api.yeswehack.com/programs/datadome-bot-bounty),
   lists `https://bounty-nodejs.datashield.co`, the Fastly and Nginx bounty
   backends, `*.captcha-delivery.com`, `js.datadome.co`, and
   `api-js.datadome.co`. Supporting-infrastructure findings only qualify as
   part of a demonstrated protected-content bypass meeting the program's
   criteria. Cookie acquisition alone and static-asset retrieval do not qualify.
   Published bounty scope is neither this packet's authorization for requests
   nor an expansion of the local runtime allowlist.

## Policy conclusion and remaining unknown

**Yes, at the response-page family level:** the vendor explicitly associates
`*.captcha-delivery.com` serving with Device Check among other response types,
and separately defines Device Check as automatic without user interaction.
**No exact static-resource classification is established:** the retrieved prose
only calls `ct.captcha-delivery.com` a response-page script host. It does not
bind the supplied asset to Device Check, Slider, Block, or an ordinary tag.
The bounded search found no exact published static-path-to-non-interactive-role
mapping; that is a documentation gap, not proof that none exists.

The current local allowlist is narrower than the vendor's CSP integration
example and publisher scope. That explains a policy mismatch, not a transport
failure or an erroneous denial: the grants are deliberately different.
Calling all CAPTCHA-delivery resources human CAPTCHA would contradict the
published family roles; calling the denied asset non-interactive would exceed
the evidence. Frames remain ungranted. Browser/app support is the documented
limit, not a global claim that other runtimes are impossible. No delivery,
execution, clearance, or protected-body proof follows from these citations.

No endpoint-classifier implementation or origin expansion is justified by this
packet. A wildcard CSP example must not become a wildcard execution grant.

## Narrow next packet

If needed, perform **public-prose-only exact-resource-role verification**:
look for vendor-published nonsecret hostname/path documentation that explicitly
maps a fixed static resource to automatic Device Check versus interactive
Slider/CAPTCHA. Do not obtain the observed asset URL from private diagnostics,
fetch the asset, inspect SDK behavior, or reconstruct a protocol. If the vendor
publishes no such mapping, retain **UNKNOWN** and the existing denial. Any later
in-memory comparison against a published classification would require a
separate bounded packet; classification alone grants no new origin or execution.
No refused investigation lane is reopened.

## Method and verification

Four varied first-party-domain searches covered CSP/domain roles, the precise
Device Check definition, publisher scope, and a possible explicit
CAPTCHA-delivery/Device Check script association. Cited documentation pages and
the public program page/API were retrieved as documentation text; no linked
challenge assets, images, scripts, or target pages were requested. Search
summaries were checked against publisher passages, not treated as authority.
Only published hostname/CSP roles and short prose quotations are retained;
no live query, private URL/hash, example page flag, key, or nonce is reproduced.

Local context read: `AGENTS.md`, the user-added `GLOSSARY.md`, both ADRs,
decisions/protocol, browser documentation, and existing DataDome/public-reference
research notes. The deleted `CONTEXT.md` and user changes in
`examples/basic-request.mjs`, `.pi/`, and `.cachebro/` were left untouched.
`oxfmt --check docs/research/datadome-public-domain-policy.md` passed.
`git diff --check` and the new-file `git diff --no-index --check` reported no
whitespace errors (the latter exits 1 for an added-file difference). Status
showed only this new document beyond the pre-existing user changes. No code
build or network/integration test was run.
