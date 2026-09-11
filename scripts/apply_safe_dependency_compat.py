from pathlib import Path

p = Path('src/routes/easynewsProxy.ts')
s = p.read_text()

anchor = "export function createEasynewsProxyRouter(config: Config): Router {"
helper = """function setAxiosResponseHeader(res: any, name: string, value: unknown): void {\n  if (typeof value === 'string' || typeof value === 'number') {\n    res.setHeader(name, value);\n  } else if (Array.isArray(value)) {\n    res.setHeader(name, value.map(String));\n  }\n}\n\n"""
assert anchor in s, 'router function marker not found'
if helper not in s:
    s = s.replace(anchor, helper + anchor, 1)

replacements = {
    "if (resolveResp.headers['content-type']) res.setHeader('Content-Type', resolveResp.headers['content-type']);": "setAxiosResponseHeader(res, 'Content-Type', resolveResp.headers['content-type']);",
    "if (resolveResp.headers['content-length']) res.setHeader('Content-Length', resolveResp.headers['content-length']);": "setAxiosResponseHeader(res, 'Content-Length', resolveResp.headers['content-length']);",
    "if (resolveResp.headers['accept-ranges']) res.setHeader('Accept-Ranges', resolveResp.headers['accept-ranges']);": "setAxiosResponseHeader(res, 'Accept-Ranges', resolveResp.headers['accept-ranges']);",
    "if (streamResp.headers['content-type']) res.setHeader('Content-Type', streamResp.headers['content-type']);": "setAxiosResponseHeader(res, 'Content-Type', streamResp.headers['content-type']);",
    "if (streamResp.headers['content-length']) res.setHeader('Content-Length', streamResp.headers['content-length']);": "setAxiosResponseHeader(res, 'Content-Length', streamResp.headers['content-length']);",
    "if (streamResp.headers['accept-ranges']) res.setHeader('Accept-Ranges', streamResp.headers['accept-ranges']);": "setAxiosResponseHeader(res, 'Accept-Ranges', streamResp.headers['accept-ranges']);",
    "if (nzbResp.headers['content-length']) res.setHeader('Content-Length', nzbResp.headers['content-length']);": "setAxiosResponseHeader(res, 'Content-Length', nzbResp.headers['content-length']);",
}
for old, new in replacements.items():
    assert old in s, f'marker not found: {old}'
    s = s.replace(old, new, 1)

p.write_text(s)
