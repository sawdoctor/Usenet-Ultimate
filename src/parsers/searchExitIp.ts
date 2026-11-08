// Return the proxy exit IP only when pre- and post-request probes agree.
// A disagreement means the VPN rotated while the axios call was in flight;
// the request may have exited on either IP, so stamping either one risks a
// search/grab mismatch the verifier cannot detect. Returning undefined makes
// the grab fail closed with "baseline unavailable" instead.
export function consensusSearchIp(preIp: string | undefined, postIp: string | undefined, indexerName: string, opLabel: string): string | undefined {
  if (preIp && postIp && preIp === postIp) return preIp;
  if (preIp && postIp && preIp !== postIp) {
    console.warn(`🔒 ⚠️ [${indexerName}] proxy IP changed mid-${opLabel} (${preIp} → ${postIp}), skipping IP stamp`);
  }
  return undefined;
}
