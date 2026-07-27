# Changelog

## [1.7.4] - 2026-07-27

### Fixed

- Synchronise the frontend package version with the application release version so the dashboard displays the correct release badge.

## [1.7.3] - 2026-07-27

### Critical fixes

- Treat only an explicit NNTP `430` response as proof that an article is missing.
  Authentication errors, temporary provider responses, timeouts, and dropped
  connections are now classified as unverified rather than dead.
- Prevent unverified health checks from returning a Newznab `410`, entering the
  permanent dead-NZB cache, lowering indexer or release-group reputation, or
  disappearing from results when **Hide Blocked** is enabled.
- Require complete usable answers from all enabled providers before a negative
  article verdict is considered conclusive. This safety behaviour is enabled by
  default and can be relaxed with `HEALTH_REQUIRE_ALL_PROVIDERS=off`.

### Search correctness

- Correct the disabled-source-filter cleanup to remove the actual
  `minFileSize` and `maxFileSize` keys, preventing hidden size filtering when
  Newznab source filtering is off.
- Add conservative sanity checks to ID-based searches: movie results with a
  contradictory release year and TV results with a contradictory explicit
  season are rejected. Ambiguous, foreign-title, anime, daily-show, and
  yearless results continue to pass.
- Preserve abbreviated multi-season ranges such as `S01-08` when the requested
  season is inside the range.

### Efficiency

- Reuse a recent successful search-time health verdict during Newznab `t=get`
  requests, avoiding an immediate duplicate round of NNTP `STAT` checks.

### Upgrade note

This release stops new false dead-cache entries, but it does not automatically
remove entries written by earlier versions. Installations that previously saw
`480 Authentication Required`, `451`, or provider disconnects during health
checks should review or clear their dead-NZB cache after making a backup.
