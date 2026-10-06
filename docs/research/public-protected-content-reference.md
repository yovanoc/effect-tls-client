# Public protected-content reference

Documentation-only CONTENTORACLE packet `task558`, at HEAD `9017015`.
The two fixed targets were **not fetched**. No Go/Bridge run, browser, CAPTCHA,
SDK inspection/execution, challenge request, cookie inspection, or acquisition
attempt was performed. Existing provider-verification notes supplied public
reference links only; their historical diagnostics were not repeated.

## First-party evidence

1. **DataDome target identity — supported.** DataDome's publisher-authored
   [Bot Bounty policy](https://yeswehack.com/programs/datadome-bot-bounty)
   explicitly lists `https://bounty-nodejs.datashield.co/` as a dedicated
   researcher environment and includes its origin in the structured scope.
   The same policy is available through the
   [public program API](https://api.yeswehack.com/programs/datadome-bot-bounty).

2. **DataDome intended content — partially supported.** The policy's
   [“Reward scenarios” section](https://yeswehack.com/programs/datadome-bot-bounty)
   specifies a flag embedded in scraped page content with the public form
   `pagehash_<random_hash>`, alongside HTTP `200`. It explicitly distinguishes
   this from hashing the raw HTML response. This establishes an expected
   content family, not a fixed literal, DOM selector, element, hash length,
   character alphabet, or complete document template. No actual/example hash
   is reproduced here.

3. **DataDome proof limitations — supported.** The policy's
   [“Important clarifications” section](https://yeswehack.com/programs/datadome-bot-bounty)
   requires a valid page-content flag regardless of response status; acquiring
   a DataDome cookie alone does not qualify. Static assets and routes excluded
   from protection do not qualify either. Matching the public prefix alone
   would not establish flag validity or protected-resource acquisition.

4. **DataDome bounty validation is separate from this reference.** The policy's
   [“How we validate” section](https://yeswehack.com/programs/datadome-bot-bounty)
   requires Dashboard-confirmed allowed requests and a page-URL/flag CSV for
   the bounty's volume threshold. This packet performs no such scenario and
   does not authorize one; a documentation reference is not bounty validation.

5. **ScrapingCourse exercise identity — supported; successful content unknown.**
   The publisher's [public exercise index](https://www.scrapingcourse.com/)
   describes demo pages to scrape, lists “Cloudflare Challenge,” and links
   `https://www.scrapingcourse.com/cloudflare-challenge` with the instruction
   to bypass the challenge. That index does not publish the successful page's
   body text, heading/element structure, selector, or complete HTML template.
   The exercise label is not a verified protected-body marker.

## Content-oracle decision

| Fixed target                       | Supported reference                                                        | Remaining gap                                                                                                                | Candidate authored verifier                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DataDome Node.js root              | Publisher specifies a page-embedded flag family and its validation limits. | Exact root-route document structure, flag location/validity contract, and fit to the strict body-text parser are unverified. | **None defined.** A prefix search or guessed regular expression would not fill these gaps.                   |
| ScrapingCourse Cloudflare exercise | Publisher identifies the exercise and its purpose.                         | Successful application body text and structure have no primary-source confirmation in this search.                           | **None defined.** Do not promote a third-party reported success message or the exercise label into a marker. |

Neither reference proves current deployment enforcement, state acquisition, or
same-session receipt of intended protected content. Readiness, token/cookie
presence, status alone, and documentation/search results are not pass proof.
Keep the existing live-target body gate unsupported; no marker, code, harness,
quota, or network-allowlist configuration was changed.

## Search and citation verification

Bounded varied queries covered official exercise content/guides, first-party
application repositories, indexed success text, DataDome target references,
and publisher policy/content criteria. No authoritative application template
was found for either exact route. This is a bounded gap, not proof that no
public template exists. Third-party bypass posts and unrelated repositories
were not used as authority; neither protected target nor its assets was fetched.

The ScrapingCourse index, YesWeHack program page, and public program API were
retrieved and read; their target links and policy passages support the five
claims above. The policy-linked Node.js integration documentation was reachable,
but was not used as an application-content oracle. A surfaced DataDome press
page returned HTTP 403 and was not used as evidence or retried via a fallback.
Only public-documentation paraphrases, generic published notation, and fixed
public citations are retained here; no live HTML/JS, SDK source, actual flag,
identifier, signed image URL, query value, or search-result ID is copied.

## Exact next packet, if pursued

**Documentation-only route-template verification:** obtain a publisher-owned
public application template or guide for each exact fixed route; establish the
successful body element/text and, for DataDome, the flag's location and validity
contract. Check those documented structures against the existing strict
complete-document/body-text contract using locally authored synthetic examples
only. Define a candidate authored verifier only for a primary-source-confirmed
structure; otherwise retain the explicit gap. No live target/asset request,
SDK/private diagnostic work, acquisition attempt, new origin, or harness change
belongs to that packet. If no public source is available, request publisher
confirmation of the application contract, not challenge payloads or secrets.
