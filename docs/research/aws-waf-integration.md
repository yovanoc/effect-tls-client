# AWS WAF application integration notes

Primary-source notes for the experimental `effect-tls-client/challenges/aws-waf` adapter; no vendor captures or private URLs are included.

- AWS documents the public `AwsWafIntegration` namespace, including `getToken`, `hasToken`, and `fetch`. `getToken()` resolves an acquired token, stores it in the `aws-waf-token` cookie, or returns an existing unexpired token; acquisition can wait up to two seconds before timing out. Use only from an HTTPS secure context.
- The documented integration asset is `integrationURL/challenge.js`. The integration and token/API requests may involve multiple AWS endpoint origins; configure each exact request origin in `BrowserMock.allowedOrigins`, separately from the `scriptOrigins` allowlist for script assets. Do not auto-allow origins discovered in a response.
- `forceRefreshToken` and `checkForceRefresh` are not stable public SDK APIs. Any page-flow compatibility involving them is experimental and cannot be treated as a universal token-refresh or challenge-resolution contract.

Sources:

- [AWS WAF application integration](https://docs.aws.amazon.com/waf/latest/developerguide/waf-application-integration.html)
- [AWS WAF JavaScript challenge API](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api.html)
- [AWS WAF JavaScript challenge API specification](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-specification.html)
- [AWS WAF `getToken` API](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-get-token.html)
- [AWS WAF tokens](https://docs.aws.amazon.com/waf/latest/developerguide/waf-tokens.html)
- [AWS WAF JavaScript API CSP guidance](https://docs.aws.amazon.com/waf/latest/developerguide/waf-javascript-api-csp.html)
- [AWS WAF token domain configuration](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-challenge-api-set-token-domain.html)
