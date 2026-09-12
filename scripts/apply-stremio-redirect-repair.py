from pathlib import Path

replacements = {
    Path("src/addon/healthCheckCoordinator.ts"): [
        (
            "fetch(proxyUrl).catch(err => console.error('❌ Auto-queue failed:', err));",
            "fetch(proxyUrl, { redirect: 'manual' }).catch(err => console.error('❌ Auto-queue failed:', err));",
        ),
    ],
    Path("src/nzbdav/streamHandler.ts"): [
        (
            "const EXO_PLAYER_BUDGET_MS = 8_000;      // Max blocking time per post-redirect request (keeps ExoPlayer alive on Android)",
            "const EXO_PLAYER_BUDGET_MS = 50_000;     // Stay below Stremio's 60s HTTP timeout without burning through client redirect limits on slow NZBDav jobs",
        ),
    ],
}

for path, changes in replacements.items():
    text = path.read_text()
    for old, new in changes:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"Expected exactly one match in {path} for {old!r}, found {count}")
        text = text.replace(old, new)
    path.write_text(text)
    print(f"patched {path}")
