# Usenet Ultimate v1.7.10

## Selected-grab health checks for Newznab / Arr clients

This patch changes Newznab health verification so Sonarr, Radarr and other Arr clients are not forced to wait while Usenet Ultimate pre-downloads and checks every search candidate.

### What changed

- Search responses no longer prefetch candidate NZBs for live health checks.
- Health checks now run only when the client actually selects an NZB via `t=get`.
- The selected NZB payload is fetched once, cached and reused for inspection and NNTP verification.
- Concurrent retries for the same NZB share the same in-flight upstream fetch and health check.
- Repeated identical Newznab searches are served from the search cache instead of repeating the upstream Prowlarr/EasyNews work.
- Positive and inconclusive selected-grab verdicts are reused briefly to avoid retry storms.
- Only conclusive blocked verdicts refuse a grab; provider errors, disconnects and unexpected NNTP responses remain unverified and fail open rather than poisoning the dead-NZB cache.
- Selected NZB inspection still records password metadata and rejects detectable invalid payloads such as empty NZBs or undeclared disc images.
- Added a small SingleFlight helper and regression test for in-flight request coalescing.
- Added CI to run `npm test` and `npm run build` on pull requests and pushes to `master`.

## Verification performed before release

The patch was tested against a live Sonarr → Usenet Ultimate → Prowlarr/EasyNews → InfiniDysk workflow.

- A new eight-episode show was requested through Seerr and all eight episodes were found and imported at normal speed.
- Two identical direct Newznab searches produced identical responses while only one upstream indexer search transaction was observed.
- A real selected NZB was inspected and NNTP-verified before UU returned HTTP 200.
- Three enabled providers (`easynews`, `supernews`, and `farm`) each confirmed all 3/3 sampled articles for the live positive test.
- Providers returning NNTP `480 Authentication Required` were treated as unverified rather than falsely missing.
- A deliberately invalid selected payload with zero NZB files was rejected with HTTP 404 and was not delivered onward.

## Notes

This release deliberately keeps the health-check patch separate from follow-up security and maintenance work. SSRF hardening, TLS certificate validation, broader NNTP protocol tests, reputation UI work and repository cleanup remain separate follow-up items.
