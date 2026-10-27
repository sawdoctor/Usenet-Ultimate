# Adaptive Fallback Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank Adaptive Fallback candidates using fresh, per-installation measurements of actual saturated stream delivery while preserving existing Filters and sort preferences.

**Architecture:** Keep bandwidth estimation in `src/nzbdav/bandwidth.ts`, keyed by a one-way hash of the manifest key and limited by freshness and capacity. Feed samples only from saturated WebDAV responses; lower estimates immediately and recover upward gradually. Rank only the already-filtered fallback group, preserving its configured order among candidates that fit, then try the lowest estimated bitrate candidates and unknown-size candidates as fallbacks.

**Tech Stack:** TypeScript, Node.js built-ins, `node:test`.

---

### Task 1: Test isolated, conservative live estimates

**Files:**
- Modify: `test/bandwidth.test.ts`
- Modify: `src/nzbdav/bandwidth.ts`

- [x] **Step 1: Add tests for per-manifest isolation, immediate downward updates, slow upward recovery, ten-minute expiration, and cache eviction.**
- [x] **Step 2: Run `node --import tsx --test --test-force-exit test/bandwidth.test.ts` and confirm the new tests fail for the expected missing scoped behavior.**
- [x] **Step 3: Replace the single global live estimate with a bounded, short-lived map keyed by hashed manifest key. Cap an unmeasured Cloudflare probe at the conservative default speed.**
- [x] **Step 4: Make a lower live sample take effect immediately and cap upward movement to 20% of the gap per sample. Ignore samples without a manifest key.**
- [x] **Step 5: Re-run the bandwidth tests and confirm they pass.**

### Task 2: Connect actual stream samples and estimates to the manifest

**Files:**
- Modify: `src/routes/nzbdav.ts`
- Modify: `src/addon/economyTile.ts`
- Modify: `src/addon/ufTile.ts`
- Modify: `src/addon/streamBuilder.ts`
- Modify: `src/nzbdav/streamHandler.ts`
- Modify: `test/bandwidth.test.ts`
- Modify: `test/economyTile.test.ts`

- [x] **Step 1: Add tests that each tile uses its manifest’s live estimate and labels the source clearly.**
- [x] **Step 2: Run the focused tests and confirm the scoped tile expectation fails before implementation.**
- [x] **Step 3: Pass the validated `req.params.manifestKey` from the WebDAV proxy sampler into the scoped recorder; pass the request manifest key through tile construction and Adaptive Fallback resolution. Label measured throughput separately from initial estimates.**
- [x] **Step 4: Re-run the focused tests and confirm they pass.**

### Task 3: Rank safe candidates by the user’s configured order

**Files:**
- Modify: `src/nzbdav/economyRank.ts`
- Modify: `src/nzbdav/types.ts`
- Modify: `src/addon/streamBuilder.ts`
- Modify: `test/economyRank.test.ts`

- [x] **Step 1: Add tests proving that candidates already excluded by Filters are never reintroduced, fitting candidates keep their existing configured order, over-budget candidates sort by estimated bitrate, and missing size metadata is not counted as a safe fit.**
- [x] **Step 2: Run the focused ranking tests and confirm the new assertions fail against the old ranking behavior.**
- [x] **Step 3: Preserve input order for known candidates within the headroom budget; sort over-budget candidates by estimated bitrate; place candidates with unknown size after candidates with measured size.**
- [x] **Step 4: Carry `estimatedEpisodeSize` into fallback candidates and use it before dividing a remote season-pack size across episodes.**
- [x] **Step 5: Re-run the focused ranking tests and confirm they pass.**

### Task 4: Verify and open the stacked PR

**Files:**
- Review: all changed files

- [x] **Step 1: Run the complete test suite and TypeScript build from the repository root.**
- [x] **Step 2: Review the diff and `git diff --check`; confirm the ranking input remains the filtered result list and no preference bounds are added or bypassed.**
- [x] **Step 3: Commit and push the feature branch.**
- [x] **Step 4: Open a new PR targeting `matt/economy-own-settings` so it remains separate from PR #9 and does not duplicate PR #9’s changes.**
