# DataDome dedicated alternate backends: public scope refresh

Checked 2026-10-01 UTC; public policy only. No protected-target requests, SDK acquisition/execution, private material, account creation, or submissions were performed.

## Primary permission sources

- [DataDome Bot Bounty public program](https://yeswehack.com/programs/datadome-bot-bounty): operator-authored rules, Scopes, Out of scopes, and qualifying/non-qualifying conditions.
- [Public program API](https://api.yeswehack.com/programs/datadome-bot-bounty): same rules and structured scope list. Retrieved without credentials; `public: true`, `disabled: false`, `archived: false`, `demo: false`. Its `last_update_at` is `2026-09-24T17:12:59+02:00`. These are program-level states, not target availability checks.

The permission-bearing public passage is:

> “The goal of this program is to find ways to bypass DataDome bot protection by implementing a scraping bot against our dedicated test environments.”

It then introduces the operator URLs as:

> “DataDome publishes these websites dedicated to researchers:”

## Exact operator targets

The following URLs occur in both the public program's **Scopes** table and the API's `scopes` array:

| Backend | Exact scope URL                       | Policy conclusion                                                  |
| ------- | ------------------------------------- | ------------------------------------------------------------------ |
| Node.js | `https://bounty-nodejs.datashield.co` | Explicitly in scope; existing lane, not new evidence.              |
| Fastly  | `https://bounty-fastly.datashield.co` | Explicitly in scope; eligible alternate for a bounded measurement. |
| Nginx   | `https://bounty-nginx.datashield.co`  | Explicitly in scope; eligible alternate for a bounded measurement. |

**CloudFront discrepancy:** the rules' researcher list also links `https://bounty-cloudfront.datashield.co/`, but neither formal scope list includes it, and qualifying conditions still say “one of the three target environments.” Do not select CloudFront under explicit-scope-only authorization; its eligibility is unresolved.

Other listed scopes are `*.captcha-delivery.com`, `js.datadome.co`, and `api-js.datadome.co`. They are supporting scopes, not alternate protected-content backends. Their presence does not authorize independent CAPTCHA investigation or widen this task.

## Constraints and public availability

All policy claims below come from the [public program/API](https://api.yeswehack.com/programs/datadome-bot-bounty):

- **Automation:** a scraping bot is expressly the program's subject. Ordinary page requests to the dedicated in-scope environments therefore fit the stated research purpose. No separate passage expressly approves this project's VM or a particular original-SDK execution harness; scope permission is not a runtime compatibility finding.
- **Single IP:** “Distributed attacks (scraping must be performed from a single IP at a time)” are out of scope. Multiple IPs, IP rotation, and distributed infrastructure are non-qualifying.
- **Availability:** “Denial of service attacks or any technique whose goal is to degrade infrastructure availability” are out of scope. No numeric maximum request rate, request budget, or concurrency ceiling is published in these program rules. The 30,000-request reward threshold and timing tiers are qualification criteria, not instructions to generate load or a replacement for a safe bounded budget.
- **Accounts:** policy and scope were publicly retrievable without login. API `account_access`, `user_agent`, and `restricted_ips` are null; `vpn_active` is false. No test-account, registration, credential, special-header, or VPN prerequisite is stated. Actual target login requirements and reachability remain untested. The public page separately says report submission requires a hunter login; submission is outside this task.
- **Challenges/CAPTCHA:** these rules state no mandatory human/CAPTCHA step and no blanket exemption from one. Whether an alternate presents a human challenge is UNKNOWN without a measurement. Stop at such a requirement; no solver, challenge modification, instrumentation, or escalation is authorized by this refresh.
- **Proof:** “Obtaining a DataDome cookie is not a bypass.” Public `200`, SDK delivery, cookie presence, static assets, and configuration-excluded URLs are not clearance evidence. Reward qualification requires protected-content page hashes, a CSV, runnable reproduction, and Dashboard-confirmed volume; none is acquired or claimed here.

## Next-measurement decision

**Fastly is an explicitly scoped alternate**, so the existing authorization restricted to explicit public scope can cover one separately dispatched, low-volume page/original-SDK measurement there using the existing VM and unmodified workflow. Nginx is also explicitly scoped. This is a permission decision only: target availability, SDK/challenge behavior, and VM suitability are UNKNOWN. Do not repeat Node.js merely to reproduce its existing UNKNOWN, infer clearance, pursue reward-volume traffic, or revive refused lanes.

The operator links [Fastly implementation documentation](https://docs.datadome.co/docs/module-fastly) from its researcher list. That page was checked only as a primary integration reference; its service-owner setup prerequisites concern deploying an integration, not a requirement to obtain Fastly/DataDome credentials to visit the dedicated bounty backend. It provides no backend-specific request budget or permission for our VM.
