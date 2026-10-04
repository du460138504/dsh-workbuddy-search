// Standalone check of the plugin's credential + search path, without DSH.
//
// Usage: node check.mjs
//
// Reads the WorkBuddy desktop credential and performs one real search, so a
// broken token or a blocked network shows up in seconds instead of at the
// first model-driven tool call.
import { loadCredential, resolveApiBase, isExpired, WORKBUDDY_SEARCH_PATH } from "./lib/auth.js";

const { credential } = await loadCredential();
console.log("credential path :", credential.path);
console.log("uid             :", credential.uid);
console.log("nickname        :", credential.nickname ?? "(none)");
console.log("domain          :", credential.domain);
console.log("token length    :", credential.accessToken.length);
console.log("expired         :", isExpired(credential));
console.log("api base        :", resolveApiBase(credential));

if (isExpired(credential)) {
	console.error("\nThe access token has expired. Open the WorkBuddy desktop app and sign in again.");
	process.exit(1);
}

const url = `${resolveApiBase(credential)}${WORKBUDDY_SEARCH_PATH}`;
const res = await fetch(url, {
	method: "POST",
	headers: {
		Authorization: `Bearer ${credential.accessToken}`,
		"Content-Type": "application/json;charset=UTF-8",
		Accept: "application/json",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": "WorkBuddy/1.0.0",
		"X-User-Id": credential.uid,
	},
	body: JSON.stringify({ query: "DeepSeek Harness plugin", type: "text2text", max_results: 5 }),
	signal: AbortSignal.timeout(30000),
});
console.log("HTTP            :", res.status);

if (!res.ok) {
	console.error(`\nSearch failed with HTTP ${res.status} ${res.statusText}.`);
	if (res.status === 401 || res.status === 403) {
		console.error("The credential was rejected. Sign in again in the WorkBuddy desktop app.");
	}
	process.exit(1);
}

const payload = await res.json();
console.log("provider        :", payload.provider);
console.log("total_results   :", payload.total_results);
console.log("response_time_ms:", payload.response_time_ms);
for (const r of payload.results ?? []) {
	console.log("  -", r.title, "|", r.url);
}
