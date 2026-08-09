# Usenet Ultimate v1.7.8

v1.7.8 focuses on the Sonarr/Radarr Newznab path: fewer unnecessary indexer
downloads, safer selected grabs, and more trustworthy reputation learning.

## Selected-grab validation with Health Checks OFF

Health Checks OFF is now a first-class low-indexer-traffic Arr configuration.

Usenet Ultimate continues to perform its normal search intelligence — title
resolution, metadata parsing, filtering, deduplication and reputation handling —
but it does not speculatively download several candidate NZBs.

Sonarr or Radarr chooses one result first. When that result is requested through
`t=get`, UU inspects the **same NZB payload already being fetched for delivery**.

That means selected-grab inspection adds **zero extra indexer NZB downloads**.

It can detect password metadata, inspect the visible NZB file list and reject
obvious bare/mislabelled disc-image payloads before they reach the download
client.

## Duplicate indexer-download protection

Repeated `t=get` requests for the same NZB now use a bounded in-memory payload
cache.

Concurrent requests are also coalesced: if the same NZB is already being fetched,
later requests join that fetch rather than starting another upstream download.

This is intended to protect indexer download quotas when Arr clients retry or
make overlapping requests.

## Better Arr reputation correlation

Search-result cache expiry could previously cause a delayed grab to lose the
release title/indexer that produced it.

v1.7.8 adds a separate bounded 24-hour URL-to-identity cache for grab
correlation.

The old synthetic `unknown:<URL>` identities are gone. If a grab genuinely
cannot be correlated, it is explicitly ignored instead of contaminating the
reputation database.

## Password metadata is diagnostic, not a failure

Real-world Arr + InfiniDysk testing showed that many NZBs containing password
metadata import successfully.

UU therefore still detects and records password metadata for diagnostics, but
the presence of that metadata **no longer reduces release-group or indexer
reputation by itself**.

If the release actually fails, the normal Arr/InfiniDysk failure outcome still
lowers reputation. If it imports successfully, that success is learned normally.

## Health Checks ON vs OFF

**Health Checks OFF — recommended for indexer-limited Arr use**

- normal UU search/filter/dedup/reputation intelligence remains active;
- Sonarr/Radarr chooses one release before its NZB is downloaded;
- UU performs selected-grab inspection using that same payload;
- no speculative candidate-NZB downloads;
- no extra indexer fetch for grab-time inspection;
- no NNTP segment-availability verification;
- no inspection inside RAR archives for hidden ISO/nested content.

**Health Checks ON — stronger pre-response verification**

- UU may download and inspect several promising candidates before responding;
- provider-side verification can be performed;
- stronger pre-grab confidence;
- necessarily higher indexer/provider traffic.

In short:

> **Health Checks OFF no longer means no validation. It means selected-grab
> validation instead of speculative pre-response verification.**

## Other changes

- Grab records are created only after selected-NZB inspection succeeds and the
  payload is actually delivered.
- Shared parser log labels now use `[NZB parser]` instead of the misleading
  `[health-check]` prefix.
- Cache/coalescing and grab-identity state remain intentionally in-memory and
  per-process; restarting UU clears them.

## Recommended Arr configuration

For users prioritising low indexer traffic:

**UU intelligence/filtering/reputation ON + Health Checks OFF**

Enable Health Checks when stronger speculative pre-grab verification is worth
the additional indexer/provider usage.
