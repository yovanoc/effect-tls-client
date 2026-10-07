# Public protected-content reference follow-up

Documentation-only follow-up, repository baseline `355cca3`. **Decision: bounded
public-documentation gap for both fixed targets; no supported positive verifier.**
The [previous content-reference note](public-protected-content-reference.md) and
[current runtime-prerequisite note](public-runtime-prerequisites.md) were read
first. Their content and runtime limits remain unchanged. This packet does not
resume acquisition-protocol research or explain the reported HTTP 403 outcomes.

## What was followed, rather than repeated

The earlier note already established target identity and a general DataDome
page-content flag family. This follow-up instead audited public publication
links for an ordinary application-content contract:

1. The [ScrapingCourse exercise catalog](https://www.scrapingcourse.com/) was
   checked for teaching-material, publisher/author, and public application-reference
   links. None was found in the extracted catalog prose/navigation. Its exercise
   label still identifies an exercise, not the successful protected body.
   The public [robots metadata](https://www.scrapingcourse.com/robots.txt) exposed
   no sitemap URL in the extraction; a single public
   [sitemap metadata check](https://www.scrapingcourse.com/sitemap.xml) returned
   HTTP 404. These are bounded discovery results, not evidence that no other
   publication or template exists.

2. The [DataDome Bot Bounty policy](https://yeswehack.com/programs/datadome-bot-bounty)
   was checked specifically for publicly linked application references, rather
   than repeating its reward-scenario search. Its documentation links cover
   deployment integrations and Dashboard data exploration. No ordinary bounty
   application template or root-route-specific body contract was found in the
   extracted policy. Its page-content proof requirement and Dashboard validation
   do not provide an independent public rule for validating an individual flag.

3. The policy-linked
   [Node.js integration page](https://docs.datadome.co/docs/module-nodejs)
   describes the older integration and directs readers to the
   [current Node.js documentation](https://docs.datadome.co/docs/nodejs) and a
   migration guide. This versioned documentation link is new follow-up evidence,
   not a deployed-version diagnosis. The permitted prose concerns integration
   and request handling, not the bounty application's successful body. No
   ordinary bounty application/example-repository reference was found in either
   page's extracted prose/navigation. The current page's Node.js repository link
   serves a runtime-maintenance reference, not a bounty application template.

No protected exercise, bounty application, challenge document, or SDK asset was
requested. Linked integration code, configuration examples, and repository
implementation bodies were not read or retained.

## Evidence that cannot close the gap

Publisher-specific publication discovery also surfaced external scraping
examples. No publisher-ownership confirmation or catalog link established those
examples as ScrapingCourse's application authority. They were not used as proof,
and no reported success text, output HTML, selector, or procedure was adopted.

A newly surfaced DataDome-authored public article,
[“How to Bypass DataDome”](https://datadome.co/bot-management-protection/how-to-bypass-datadome/),
was requested only for publication prose and public application-reference links.
It returned HTTP 403. Its body was not read; search summaries are not confirmation
of a content contract. No retry, fallback, configuration change, or request to
its assets was made. The previously inaccessible press announcement was not
retried.

## Content-verifier decision and exclusions

| Fixed target                                                                              | Still-supported reference                                                                                                           | Missing positive-verifier contract                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataDome Node.js root, `https://bounty-nodejs.datashield.co/`                             | The existing policy specifies a variable flag embedded in page content and separates it from status, cookies, and raw-HTML hashing. | No root-specific successful document/body structure, flag element/location, or independently checkable flag-validity rule was confirmed. Integration prose supplies none of these. |
| ScrapingCourse Cloudflare exercise, `https://www.scrapingcourse.com/cloudflare-challenge` | The publisher catalog identifies the exercise.                                                                                      | No publisher-confirmed successful body text, element structure, or public application template was confirmed. Publication-metadata discovery supplied no such contract.            |

**Neither target has an authored verifier justified by this evidence.** A guessed
prefix/regular expression, catalog label, third-party success sentence, or
synthetic document matching our parser would manufacture an oracle rather than
establish one. No literal marker, selector, pattern, or fixture is proposed.

The [existing live body gate](../browser.md#live-measurement-harness) requires
supported text in the complete strict document, excluding head metadata and
script/noscript text, and rejects its documented hidden/style/unsupported cases.
The public sources do not confirm that either successful application fits that
contract. Parser compatibility cannot be inferred from ordinary integration
support or a successful status.

Documentation cannot prove current enforcement, unchanged provider-script
completion, an accepted authoritative Go Jar change, or same-session receipt of
protected content. Cookie presence, readiness, status alone, and absence of a
recognized challenge remain insufficient. Keep `NO_SUPPORTED_VERIFIER`; no
harness, network policy, parser, quota, marker, or Jar behavior changes follow.

## Bounded result and next evidence needed

This is a finite publication/link audit, not an exhaustive absence claim. The
next admissible evidence would be publisher-authored public prose or an explicitly
public ordinary application reference specifying the successful body for the
exact route and, for DataDome, flag location and validity. Without that, retain
the gap or seek publisher confirmation of the content contract through a
separately authorized channel. Do not substitute live target/challenge requests,
private SDK inspection, a renderer, CAPTCHA work, fabricated fingerprints, or
acquisition research.

## Read coverage and local verification

Read in full: global/repository `AGENTS.md`, `GLOSSARY.md`, both ADRs,
`docs/agents/domain.md`, design decisions including D21, the wire protocol, all
of `docs/browser.md`, both starting research notes, and the research skill.
The deleted `CONTEXT.md` and unrelated user files were preserved.

Public reads were restricted to extracted publication prose/navigation/metadata;
only paraphrases and fixed public citations are recorded. No actual flag,
cookie value, private query, exception stack, SDK inventory, or raw vendor
HTML/JavaScript was copied into the repository. No live run, browser, CAPTCHA,
token request, publisher contact, commit, or push occurred.

Verification: `oxfmt --check` on this note and `git diff --check` passed. The
untracked-file `git diff --no-index --check` against `/dev/null` produced no
whitespace findings (its exit status 1 denotes the new-file difference).
