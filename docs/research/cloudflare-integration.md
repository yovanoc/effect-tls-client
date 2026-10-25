# Cloudflare Turnstile integration notes

Primary-source notes for the experimental browser/challenge integration. No vendor captures or live challenge, widget, Siteverify, or protected-resource probes are included.

- **Widget lifecycle is callback-driven.** Non-Interactive and Invisible describe interaction/presentation modes; widget appearance or execution settings do not force either mode. `turnstile.ready`/`onload` signal readiness; `render` creates a widget and `execute` starts deferred execution, neither is a token-acquisition promise. Await an application-owned promise settled by documented callbacks; no public contract says promises returned by callbacks are awaited. `reset` resets/restarts a widget and `remove` removes it without callbacks. Disable automatic retry/refresh when the caller owns the bounded lifecycle.
- **Tokens are not clearance evidence.** A Turnstile token expires after 300 seconds and is single-use. Siteverify validates a token; it does not generate one. Keep the secret on the application backend and validate expected hostname/action there. A token alone does not prove access to the protected resource.
- **Do not invent an iframe protocol.** Cloudflare's CSP guidance requires allowing its scripts and iframes. The consulted public docs do not define an iframe `postMessage` acquisition protocol; fabricated success messages are not a supported substitute.
- **The project's frame loader is not a Turnstile integration.** `BrowserMock` now has an experimental, load-only `frameReviewer`: it receives untrusted frame metadata/HTML and explicitly selects source strings for a separate VM realm. It has no renderer, child networking, or `postMessage`; the exact-origin `allowedOrigins` network grant is separate from the source-selection grant. This does not provide Turnstile lifecycle, token acquisition, or clearance, and does not change the public-doc finding above.
- **Pre-clearance is separate and opt-in.** It is disabled by default and, when configured, issues `cf_clearance` in addition to a Turnstile token. Zone/hostname, clearance level, and Challenge Passage affect its scope/lifetime. Preserve state in the existing Go Jar; a fresh cookie is only a reason for a bounded retry. Require a same-session follow-up to the protected resource before claiming clearance.
- **Recognize the documented challenge marker, not generic symptoms.** Cloudflare documents the `cf-mitigated: challenge` response header. A generic 403 or widget presence is not equivalent. The public demo uses testing keys and echoes Siteverify validation; dummy tokens are rejected by production secrets, and the demo does not prove production clearance or protected-resource access.

Sources:

- [Widget modes](https://developers.cloudflare.com/turnstile/concepts/widget/)
- [Client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
- [Widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)
- [Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [CSP guidance](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
- [Clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)
- [Challenge detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
- [Demo source at pinned commit](https://github.com/cloudflare/turnstile-demo-workers/tree/e8dbbd5d3be28a8ab0d9b3e1fc27d190f08bff59)
- [Testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
