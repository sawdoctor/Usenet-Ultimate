from pathlib import Path

readme = Path('README.md')
text = readme.read_text()
marker = '## What\'s New in v1.8.0\n'
if marker not in text:
    raise SystemExit('v1.8 marker not found')

section = '''## What's New in v1.9.0

Version 1.9.0 adds local NNTP provider-performance analytics built from the
article checks Usenet Ultimate already performs. The feature is deliberately
observe-only: it does not add provider traffic, reorder providers, change
pool/backup priority, disable providers, or alter health-check verdicts.

### Provider performance analytics

- Records provider-local NNTP article outcomes from existing health checks:
  `223` found, explicit `430` missing, and unknown/unverified replies.
- Tracks provider-check success, sampled-article coverage, answer rate, average
  latency, operational failures, and backup-provider rescues.
- Keeps pool and backup providers visibly distinct so unlike workloads are not
  presented as a single misleading score.
- Stores data locally in `config/provider-reputation.json`; provider credentials,
  hostnames and ports are never exposed by the dashboard API.
- Deleted providers retain retired historical records instead of silently losing
  accumulated evidence.

### Provider Performance dashboard

- Adds a dedicated Provider Performance card and mobile-friendly analytics panel.
- Includes sortable provider observations, response-time comparison, article
  answer-rate comparison, and found/missing/unknown outcome distribution.
- Shows Fastest, Best Answer Rate, Highest Coverage and Most Backup Saves using
  the raw observed measurements rather than an invented composite score.
- Expanding a provider exposes raw counters plus authentication, TLS, timeout,
  connection and other operational failure buckets.

### Rolling history

- Lifetime totals remain available indefinitely.
- Compact hourly buckets retain 31 days of observations and power genuine
  **24h / 7d / 30d** views.
- History is recorded from v1.9 onward; older cumulative observations are kept in
  Lifetime rather than being assigned fabricated timestamps.

### Validation

The feature was exercised on live Sonarr, Radarr and Radarr4K acquisition traffic
with Health Checks enabled. Real provider samples produced both `223` found and
explicit `430` missing outcomes while normal acquisitions continued successfully.
The rolling 24h view was verified to accumulate new observations independently of
pre-v1.9 lifetime data. Automated tests cover metric derivation, operational
failure classification and rolling-window aggregation.

---

'''

text = text.replace(marker, section + marker, 1)
readme.write_text(text)
