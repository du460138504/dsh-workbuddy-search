# DSH WorkBuddy Search

Adds a **`workbuddy_search`** tool to DeepSeek Harness: search runs through your WorkBuddy account and credits, spending **nothing on the DeepSeek account**.

Use it alongside [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect): once the model is switched to WorkBuddy, search follows the same account and no `DEEPSEEK_API_KEY` is needed.

## The problem it solves

DSH's built-in `web_search` goes through `web-search-deepseek`, which needs a DeepSeek API key or account session. When you switch the model to WorkBuddy (`provider: workbuddy`), the built-in search fails outright:

```
DeepSeek search has no API key for "DEEPSEEK_API_KEY"
```

This plugin reuses the credentials the WorkBuddy desktop app already signed in with, calling WorkBuddy's search endpoint directly.

## It coexists with the built-in `web_search`

**Neither affects the other.** The built-in tool still goes through DSH's `ctx.web` seam; this one pins the WorkBuddy upstream. The model can pick per call, or use both.

## Install

```sh
dsh plugin --profile desktop add github:du460138504/dsh-workbuddy-search
dsh --profile desktop
```

The plugin ships its own `cordis.patch.yml` and `dsh.bundle.patch` points at it, so registration is automatic — no hand-written profile patch entry.

Restart DSH and `workbuddy_search` appears in the tool list.

### From source

```sh
git clone https://github.com/du460138504/dsh-workbuddy-search
dsh plugin --profile desktop add link:/path/to/dsh-workbuddy-search
```

## Requirements

**The WorkBuddy desktop app must be installed and signed in.** The plugin reads its credential file:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| Windows (older) | `%APPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| Linux | `$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

On Windows, `Local` is probed before `Roaming`; on Linux, the config home before the data home (UOS/deepin write to the latter).

Set `WORKBUDDY_AUTH_FILE` to point somewhere else. The plugin **only reads** this file — it never writes to it or touches the app's sign-in state.

### Encrypted credentials (WorkBuddy 5.6.2 and later)

From **5.6.2**, WorkBuddy seals `accessToken`/`refreshToken`. The plugin detects both shapes and handles each:

| WorkBuddy version | Credential shape | Plugin behaviour |
|---|---|---|
| ≤ 5.3.x | plaintext JSON | read directly |
| ≥ 5.6.2 | `{$wbEncrypted:1, envelope:"…"}` wrapper | decrypted automatically |

Decryption needs the app's at-rest secret, which only the Electron binary hands out. The plugin spawns the WorkBuddy executable as Node (`ELECTRON_RUN_AS_NODE=1`) running an inline script, then opens the envelope with **AES-256-GCM**, using the app's own `WB-AAD\0` authenticated context as AAD. This matches how [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) does it.

If the app cannot be located automatically, point at its executable:

```sh
# Windows
set WORKBUDDY_ELECTRON_BIN=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe
# macOS
export WORKBUDDY_ELECTRON_BIN="/Applications/WorkBuddy.app/Contents/MacOS/Electron"
```

Default locations probed automatically:

| Platform | Electron executable |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` |
| macOS | `/Applications/WorkBuddy.app/Contents/MacOS/Electron`, then the same path under `~/Applications` |
| Linux | none — the desktop app has no verified layout there, so `WORKBUDDY_ELECTRON_BIN` is required |

On macOS this is the **Electron executable inside the bundle**, not the app launcher: `ELECTRON_RUN_AS_NODE` needs the former.

DSH must be **fully restarted** afterwards (the variable is read when the credential is, not at startup).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Install refused as incompatible | Kernel is not `0.2.0-rc.2` | Upgrade/downgrade DSH, or grant an explicit exemption with `dsh plugin allow-version` |
| `workbuddy_search` missing from the tool list | Plugin did not load | Check the plugin panel for an "异常" badge; restart DSH |
| "No WorkBuddy credential found" | WorkBuddy app missing or signed out | Sign in; or set `WORKBUDDY_AUTH_FILE` |
| "could not be found to read its at-rest key" | Credential is sealed but the app is missing | Set `WORKBUDDY_ELECTRON_BIN` to the WorkBuddy executable |
| "does not match the credential's envelope" | Envelope was sealed by a different install | Open the WorkBuddy app once so it reseals the sign-in |
| "could not be decrypted" | The at-rest key changed | Same — open the app to reseal |
| "exists but is unreadable" | Neither plaintext nor a decodable envelope | Repair or remove the file; it is the identity authority and outranks other candidates |
| "access token has expired" | Sign-in expired | Sign in again in the WorkBuddy app |
| 401/403 | Credential rejected by the server | Same — sign in again |
| Plugin card shows "异常" | `apply()` threw | Usually a kernel API mismatch; check the version requirement |

When the plugin panel reports a problem, run `node check.mjs` to separate a credential/network failure from a plugin-load failure. It prints the credential's **format** (plaintext or encrypted), which matters most when diagnosing seal-related failures.

## Usage

The model calls it on its own; you can also ask for it explicitly. Parameters:

| Parameter | Type | Description |
|---|---|---|
| `queries` | `string[]` | 1–4 search queries; their results are merged |

Returns a markdown list with a title, URL, and snippet per result.

## Billing

Requests go to WorkBuddy's agent-tool endpoint, authenticated with your WorkBuddy access token, and are **billed to WorkBuddy credits**. The DeepSeek account is not involved at all.

## Token expiry

The plugin **fails fast**: when the token has expired the tool returns a clear error telling you to reopen the WorkBuddy desktop app and sign in again. It never attempts an automatic refresh.

A 401/403 from the server produces the same guidance.

## Known limitations

- Depends on a WorkBuddy client interface (not an official public API); a WorkBuddy update may require adjustments here.
- Supports the **mainland WorkBuddy** build only. The international build (WorkBuddy AI) is unverified.
- No automatic token refresh; re-sign-in in the desktop app after expiry.
- Upstream parameters such as `blocked_domains` / `freshness` are not exposed yet.
- Verified on Windows with DSH Desktop only; other platforms follow the same credential-path convention and feedback is welcome.

## Disclaimer

- This project is **for personal study and research only**. It drives the user's own WorkBuddy account on their own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with WorkBuddy's terms of service. Any consequences of use (including but not limited to account restrictions, cleared credits, or service interruption) are the user's own responsibility.
- The author accepts no liability for any direct or indirect loss arising from use or misuse of this project.
- This project is not affiliated with, endorsed by, or authorized by Tencent, WorkBuddy, or DeepSeek. Names appear only to describe compatibility; trademarks belong to their respective owners.

## Credits

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — reference for credential discovery and DSH provider registration.
- [du460138504/dsh-dual-balance](https://github.com/du460138504/dsh-dual-balance) (MIT) — reference for DSH plugin package layout.

## License

[MIT](./LICENSE)

## Development

```sh
git clone https://github.com/du460138504/dsh-workbuddy-search
cd dsh-workbuddy-search

# Standalone self-check: bypasses DSH, reads the credential and makes one real request
node check.mjs
```

`check.mjs` prints the credential path, account, token expiry, and API base, then performs a real search — a quick way to confirm both token and network are fine.

After editing the source, a `link:` install lets DSH read the new code directly, but **DSH must be restarted** to reload the plugin.
