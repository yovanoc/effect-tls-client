# DataDome integration notes

Primary-source notes for a possible experimental browser/challenge integration. No vendor captures or live challenge, protected-resource, or cookie probes are included.

- **Device Check is not a documented VM acquisition API.** It assesses browser/device properties including canvas rendering and execution timing, and may escalate to CAPTCHA. Invisible mode concerns presentation; it does not document a renderer-free protocol. The web tag sets `window.ddjskey` and `window.ddoptions` before loading `tags.js`; documented environments are browsers, not Node/Bun VMs. CSP guidance includes response-page iframes and Blob workers.
- **The project's experimental frame path does not close this gap.** `BrowserMock` can load a caller-reviewed frame and execute only explicitly selected source in a separate VM realm, but it does not render the page or implement Device Check, its SDK, or a frame message/cookie protocol. Child network calls, script loads, cookie writes, navigation, and messaging are unsupported; this is not DataDome SDK support.
- **Tag events describe the tag, not protected-page success.** `enableTagEvents` dispatches `dd_ready`, `dd_post`, `dd_post_done`, `dd_blocked`, `dd_response_displayed`, `dd_response_error`, `dd_response_passed`, and `dd_response_unload` as `CustomEvent`s on `window`; event properties are in `.detail`. Challenge lifecycle events apply to intercepted XHR/fetch, not blocked document navigation. Events or a fresh cookie alone do not prove a protected request passed.
- **Display APIs are not acquisition APIs.** `exposeCaptchaFunction` exposes `window.displayDataDomeResponsePage(url, root?, challengeType?)` and disables automatic display. The overview also uses the name `displayDataDomeCaptchaPage`; treat this as a documentation discrepancy, not an alias contract. A `challengeRoot` element selects where a response page is displayed; none of these names documents Device Check completion.
- **Avoid duplicate or unsafe replay.** Default behavior aborts a blocked request and reloads after a challenge passes. `replayAfterChallenge` suppresses refresh and replays only the first concurrently blocked request. Do not combine SDK replay with Browser retries or replay submissions.
- **Keep cookie and message boundaries explicit.** `datadome` is encrypted assessment state; `dd_testcookie` is a temporary capability test. `ddSession` requires header-mode local storage and `ddOriginalReferrer` uses session storage. Preserve server-issued cookie attributes; DataDome warns against changing them or HttpOnly. No inspected public source defines a web-iframe message/cookie protocol. The React Native example's `ReactNativeWebView.postMessage` bridge passes a Cookie-header string and is not that web contract. Preserve actual same-origin `Set-Cookie` in the Go-owned Jar. Browser cross-origin script requests use `omitCredentials`, so they do not inject cookies or apply response `Set-Cookie`; do not infer a cross-origin cookie handoff from the native example.
- **Treat response markers and demo results narrowly.** The public sample's `X-DD-B: 1` is an example deployment marker, not a universal DataDome signal; server fail-open and API decision headers mean an unmarked 200 is not clearance evidence. At pinned sample commit `969816a0595cc528e64675c39bf136d48e866773`, the client issues `HEAD /`, `HEAD /omit`, and `HEAD /blocked`; the blocked example describes CAPTCHA, not Device Check. No live HEAD probe was made. Earlier GET 200 observations establish availability only, not current enforcement or clearance.

Sources:

- [Device Check](https://docs.datadome.co/docs/device-check)
- [JavaScript tag](https://docs.datadome.co/docs/javascript-tag)
- [Tag options](https://docs.datadome.co/docs/how-to-configure-the-javascript-tag)
- [Cookie/session storage](https://docs.datadome.co/docs/cookie-session-storage)
- [React Native example](https://docs.datadome.co/docs/sdk-react_native-axios-v_02)
- [Protection API](https://docs.datadome.co/reference/validate-request)
- [Pinned Next.js demo](https://github.com/DataDome/datadome-nextjs-demo/tree/969816a0595cc528e64675c39bf136d48e866773)
- [Project cookie contract](../design/03-protocol.md#6-request--response)
