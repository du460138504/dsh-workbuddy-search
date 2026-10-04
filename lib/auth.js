/**
 * WorkBuddy desktop credential discovery and parsing.
 *
 * The WorkBuddy desktop app writes its sign-in state to a plaintext JSON
 * document under the shared `CodeBuddyExtension` auth directory. On Windows
 * current builds write under `%LOCALAPPDATA%` and older ones under
 * `%APPDATA%`, so both are probed in that order.
 *
 * Only the fields the search endpoint needs are read: `auth.accessToken`,
 * the account identity, and the API domain. Nothing is written back.
 *
 * @module dsh-workbuddy-search/auth
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shared auth directory, relative to an AppData root. */
const AUTH_RELATIVE_PATH = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
];

/** Auth-file basename for the mainland WorkBuddy app. */
export const WORKBUDDY_AUTH_FILENAME = "workbuddy-desktop.info";

/** Env override for the auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";

/** Default API host when the credential carries no domain. */
export const DEFAULT_API_HOST = "https://www.codebuddy.cn";

/** Path of the search endpoint, appended to the resolved host. */
export const WORKBUDDY_SEARCH_PATH = "/agenttool/v1/search";

/**
 * Platform-default candidates for the WorkBuddy auth file, in probe order.
 *
 * @returns absolute auth-file paths to try, in order.
 */
export function defaultAuthCandidates() {
	const home = homedir();
	if (process.platform === "win32") {
		return [
			join(home, "AppData", "Local", ...AUTH_RELATIVE_PATH, WORKBUDDY_AUTH_FILENAME),
			join(home, "AppData", "Roaming", ...AUTH_RELATIVE_PATH, WORKBUDDY_AUTH_FILENAME),
		];
	}
	if (process.platform === "darwin") {
		return [
			join(home, "Library", "Application Support", ...AUTH_RELATIVE_PATH, WORKBUDDY_AUTH_FILENAME),
		];
	}
	const configHome = process.env["XDG_CONFIG_HOME"]?.trim() || join(home, ".config");
	const dataHome = process.env["XDG_DATA_HOME"]?.trim() || join(home, ".local", "share");
	return [
		join(configHome, ...AUTH_RELATIVE_PATH, WORKBUDDY_AUTH_FILENAME),
		join(dataHome, ...AUTH_RELATIVE_PATH, WORKBUDDY_AUTH_FILENAME),
	];
}

/**
 * Every auth-file candidate, taking the env override into account first.
 *
 * @returns absolute auth-file paths to try, in order.
 */
export function authCandidates() {
	const override = process.env[WORKBUDDY_AUTH_FILE_ENV]?.trim();
	const defaults = defaultAuthCandidates();
	return override !== undefined && override !== "" ? [override, ...defaults] : defaults;
}

/**
 * Normalize an expiry that may arrive in seconds or milliseconds.
 *
 * @param value - raw `expiresAt` field.
 * @returns milliseconds since the epoch, or 0 when absent/unusable.
 */
function expiryToMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}

/** Return a non-empty string field, else undefined. */
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a WorkBuddy auth document.
 *
 * Accepts both on-disk shapes the app is known to write: the nested
 * `{"auth":{...},"account":{...}}` form and a flat panel form where the token
 * and identity share one level.
 *
 * @param text - raw auth-file contents.
 * @returns the parsed credential, or undefined when no access token is present.
 */
export function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}

	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return undefined;

	return {
		accessToken,
		expiresAtMs: expiryToMs(auth["expiresAt"]),
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		nickname: optionalString(identity["nickname"]),
		enterpriseId: optionalString(identity["enterpriseId"]),
	};
}

/**
 * Resolve the API base URL for a parsed credential.
 *
 * The credential's `domain` is a bare host (for example `www.codebuddy.cn`);
 * the mainland endpoint is the only one that serves `/agenttool/v1/search`.
 *
 * @param credential - a parsed credential.
 * @returns the base URL without a trailing slash.
 */
export function resolveApiBase(credential) {
	const raw = credential.domain.trim();
	if (raw === "") return DEFAULT_API_HOST;
	if (/^https?:\/\//iu.test(raw)) return raw.replace(/\/+$/u, "");
	return `https://${raw.replace(/\/+$/u, "")}`;
}

/**
 * Read the first usable WorkBuddy credential from the candidate paths.
 *
 * @returns the credential plus the path it came from.
 * @throws when no candidate file yields a credential.
 */
export async function loadCredential() {
	const candidates = authCandidates();
	const failures = [];
	for (const path of candidates) {
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const credential = parseWorkBuddyAuth(text);
		if (credential === undefined) {
			failures.push(`${path}: no accessToken in document`);
			continue;
		}
		return { credential: { ...credential, path } };
	}
	throw new Error(
		`No WorkBuddy credential found. Sign in with the WorkBuddy desktop app, or set ${WORKBUDDY_AUTH_FILE_ENV}. Tried: ${failures.join("; ")}`,
	);
}

/**
 * Whether a parsed credential's access token is past its stated expiry.
 *
 * A credential with no `expiresAt` is treated as live: the server is the
 * authority, and this only exists to fail fast with a useful message.
 *
 * @param credential - a parsed credential.
 * @returns true when the token is known to be expired.
 */
export function isExpired(credential) {
	if (credential.expiresAtMs === 0) return false;
	return Date.now() >= credential.expiresAtMs;
}
