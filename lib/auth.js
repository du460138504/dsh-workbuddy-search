/**
 * WorkBuddy desktop credential discovery, classification, and decryption.
 *
 * The WorkBuddy desktop app writes its sign-in state to a JSON document under
 * the shared `CodeBuddyExtension` auth directory. Two on-disk shapes exist:
 *
 * - **plaintext** — `accessToken` is a string; the regular parser reads it.
 * - **encrypted** — `accessToken`/`refreshToken` are sealed field wrappers
 *   (`{$wbEncrypted: 1, envelope: "<base64 JSON>"}`, app 5.6+). Opening them
 *   needs the app's at-rest secret, which only the Electron binary hands out,
 *   so a helper subprocess is spawned.
 *
 * The envelope layout and its authenticated-context AAD are transcribed from
 * the app's own bundle and verified against 5.6.2 by dsh-workbuddy-connect;
 * this module implements exactly that one suite rather than guessing at
 * future framings.
 *
 * Only the fields the search endpoint needs are read: the access token, the
 * account identity, and the API domain. Nothing is ever written back.
 *
 * @module dsh-workbuddy-search/auth
 */

import { execFile } from "node:child_process";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

/** Env override for the WorkBuddy Electron binary used to read the at-rest key. */
export const WORKBUDDY_ELECTRON_BIN_ENV = "WORKBUDDY_ELECTRON_BIN";

/** Default API host when the credential carries no domain. */
export const DEFAULT_API_HOST = "https://www.codebuddy.cn";

/** Path of the search endpoint, appended to the resolved host. */
export const WORKBUDDY_SEARCH_PATH = "/agenttool/v1/search";

/** Credential fields the app seals. */
const AUTH_FIELDS = ["accessToken", "refreshToken"];

/** The marker on a sealed field wrapper. */
const SEALED_MARKER = "$wbEncrypted";

/** The only envelope suite this format defines. */
const SEALED_SUITE = 1;

/** The helper the Electron binary runs to print its at-rest secret. */
const HELPER_SCRIPT =
	'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

/** How long the key helper may run before it is killed. */
const HELPER_TIMEOUT_MS = 10_000;

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
 * Platform-default candidates for the WorkBuddy Electron binary.
 *
 * @returns absolute executable paths to try, in order.
 */
export function electronCandidates() {
	if (process.platform !== "win32") return [];
	const home = homedir();
	const local = process.env["LOCALAPPDATA"]?.trim() || join(home, "AppData", "Local");
	return [
		join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"),
	];
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

/** Decode strict base64, optionally requiring an exact byte length. */
function parseBase64(value, length) {
	if (typeof value !== "string" || value === "") return undefined;
	let decoded;
	try {
		decoded = Buffer.from(value, "base64");
	} catch {
		return undefined;
	}
	if (decoded.length === 0) return undefined;
	if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
	return length === undefined || decoded.length === length ? decoded : undefined;
}

/**
 * Decode one sealed field wrapper into its envelope.
 *
 * The wrapper is `{$wbEncrypted: 1, envelope: "<base64 of a JSON
 * {suite,keyId,nonce,authTag,ciphertext}>"}`. A value claiming the marker
 * whose envelope cannot be decoded is not decodable by any key, so it is
 * refused rather than reported as encrypted.
 *
 * @param field - the credential field name, used in diagnostics only.
 * @param value - the raw value from the document.
 * @returns `{field, envelope}`, or undefined when this is not a valid wrapper.
 */
function parseWrappedField(field, value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const wrapped = value;
	if (wrapped[SEALED_MARKER] !== 1 || typeof wrapped["envelope"] !== "string") return undefined;

	let inner;
	try {
		inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;

	const parts = inner;
	const nonce = parseBase64(parts["nonce"], 12);
	const authTag = parseBase64(parts["authTag"], 16);
	const ciphertext = parseBase64(parts["ciphertext"]);
	if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
	if (typeof parts["suite"] !== "number" || !Number.isInteger(parts["suite"])) return undefined;
	if (parts["suite"] !== SEALED_SUITE) return undefined;
	if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return undefined;

	return {
		field,
		envelope: {
			suite: parts["suite"],
			keyId: parts["keyId"],
			nonce,
			authTag,
			ciphertext,
		},
	};
}

/**
 * Classify a desktop auth document's on-disk format.
 *
 * Exported for diagnostics: an encrypted document is the one thing a reporter
 * cannot guess from the outside, and the search tool's failure mode depends on
 * it.
 *
 * @param text - raw file contents.
 * @returns `{format: "absent"}`, `{format: "plaintext"}`, `{format: "encrypted", wrapped}`,
 *   or `{format: "unrecognized"}`.
 */
export function classifyDesktopAuthDocument(text) {
	if (text.trim() === "") return { format: "absent" };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { format: "unrecognized" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { format: "unrecognized" };

	const document = parsed;
	const auth = typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document;
	const fields = [];
	for (const field of AUTH_FIELDS) {
		const value = auth[field];
		if (typeof value === "string") continue;
		const wrapped = parseWrappedField(field, value);
		if (wrapped === undefined && value !== undefined) return { format: "unrecognized" };
		if (wrapped !== undefined) fields.push(wrapped);
	}
	if (fields.length === 0) return { format: "plaintext" };
	return { format: "encrypted", wrapped: { document, fields } };
}

/** The envelope key ids present across a document's sealed fields. */
function keyIdsOf(fields) {
	return [...new Set(fields.map((wrapped) => wrapped.envelope.keyId))];
}

/**
 * The authenticated-context AAD for one field envelope.
 *
 * Transcribed from the app bundle's `buildAuthenticatedContextAad`: credential
 * fields are always suite 1 under the `field` framing, whose family tag is
 * `WBEV1`. The framing family's other members belong to other document kinds
 * and are deliberately not implemented.
 *
 * @param keyId - the envelope's key id.
 * @param suite - the envelope's suite number.
 * @returns the AAD bytes.
 */
function buildAuthenticatedContextAad(keyId, suite) {
	const prefix = Buffer.from("WB-AAD\0", "ascii");
	const lengthPrefixed = (value) => {
		const bytes = Buffer.from(value, "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(bytes.length);
		return Buffer.concat([header, bytes]);
	};
	const suiteBytes = Buffer.allocUnsafe(4);
	suiteBytes.writeUInt32BE(suite);
	return Buffer.concat([
		prefix,
		Buffer.from([1]),
		lengthPrefixed("WBEV1"),
		lengthPrefixed("sym-v1"),
		suiteBytes,
		lengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0]),
	]);
}

/**
 * Open one envelope with a protector key.
 *
 * @param key - the derived 32-byte protector key.
 * @param envelope - a decoded envelope.
 * @returns the plaintext, or undefined when the key or format does not match.
 */
function openAuthField(key, envelope) {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
		decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
		decipher.setAuthTag(envelope.authTag);
		return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return undefined;
	}
}

/** Derive the protector key: sha256 over the secret's UTF-8 string. */
function deriveProtectorKey(secret) {
	return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Validate the helper's payload against the app's own rules: `version: 1` and
 * a canonical-base64 32-byte, non-all-zero secret.
 *
 * @param text - the helper's stdout.
 * @returns the canonical secret, or undefined.
 */
function parseAtRestPayload(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const payload = parsed;
	if (payload["version"] !== 1) return undefined;
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") return undefined;
	const decoded = parseBase64(secret, 32);
	if (decoded === undefined) return undefined;
	if (decoded.toString("base64") !== secret) return undefined;
	if (decoded.every((byte) => byte === 0)) return undefined;
	return secret;
}

/** Whether an Electron candidate looks runnable. */
function isUsableElectron(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Locate the WorkBuddy Electron binary.
 *
 * An explicit path is used as-is and never falls back; discovery runs only
 * when no explicit path was configured.
 *
 * @returns the executable path.
 * @throws when no candidate exists and none was configured.
 */
function resolveElectronPath() {
	const explicit = process.env[WORKBUDDY_ELECTRON_BIN_ENV]?.trim();
	if (explicit !== undefined && explicit !== "") {
		if (!existsSync(explicit)) {
			throw new Error(
				`${WORKBUDDY_ELECTRON_BIN_ENV} points at ${explicit}, which does not exist. Fix or unset it.`,
			);
		}
		return explicit;
	}
	const found = electronCandidates().find(isUsableElectron);
	if (found !== undefined) return found;
	throw new Error(
		`The WorkBuddy credential is encrypted, but the WorkBuddy app could not be found to read its at-rest key. Install the WorkBuddy desktop app, or set ${WORKBUDDY_ELECTRON_BIN_ENV} to its executable.`,
	);
}

/**
 * Condense a helper failure into one diagnostic line.
 *
 * The child's stderr arrives embedded in the error message with a full Node
 * stack trace; only the first meaningful line is kept so the failure the user
 * reads names the actual cause.
 *
 * @param form - the form that failed, for the prefix.
 * @param error - the thrown error.
 * @returns one line naming the form and the underlying cause.
 */
function describeHelperFailure(form, error) {
	const raw = error instanceof Error ? error.message : String(error);
	const detail =
		raw
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.find((line) => line !== "" && !line.startsWith("at ") && !line.startsWith("node:internal")) ??
		raw.slice(0, 160);
	return `${form}: ${detail.slice(0, 200)}`;
}

/**
 * Run the helper so its payload lands in a temp file, with a pipe as fallback.
 *
 * A confined DSH sandbox can refuse to open the named pipes that `pipe` stdio
 * needs, making `execFile` fail with EPERM before the child ever runs. Having
 * the child write its own file and leaving every stdio channel at `ignore`
 * avoids pipes entirely, so that path is tried first. The pipe form remains as
 * a fallback for environments where the temp directory is unwritable but
 * pipes work.
 *
 * @returns the helper's payload text.
 * @throws when neither form produces a payload.
 */
async function runKeyHelper(electronPath) {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	const failures = [];

	// Form 1: the child writes the payload itself; no pipe is ever created.
	const outPath = join(tmpdir(), `dsh-workbuddy-key-${randomBytes(8).toString("hex")}.json`);
	const writeScript =
		`require("node:fs").writeFileSync(${JSON.stringify(outPath)}, ` +
		`String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))`;
	try {
		await new Promise((resolve, reject) => {
			execFile(
				electronPath,
				["-e", writeScript],
				{ timeout: HELPER_TIMEOUT_MS, windowsHide: true, stdio: "ignore", env },
				(error) => (error === null || error === undefined ? resolve() : reject(error)),
			);
		});
		const text = await readFile(outPath, "utf8");
		if (text.trim() !== "") return text.trim();
		failures.push("temp-file form returned an empty payload");
	} catch (error) {
		failures.push(describeHelperFailure("temp-file form failed", error));
	} finally {
		await rm(outPath, { force: true }).catch(() => {});
	}

	// Form 2: the original pipe form.
	try {
		const stdout = await new Promise((resolve, reject) => {
			execFile(
				electronPath,
				["-e", HELPER_SCRIPT],
				{ timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env },
				(error, out) => (error === null || error === undefined ? resolve(out) : reject(error)),
			);
		});
		if (String(stdout).trim() !== "") return String(stdout).trim();
		failures.push("pipe form returned an empty payload");
	} catch (error) {
		failures.push(describeHelperFailure("pipe form failed", error));
	}

	throw new Error(`The WorkBuddy key helper (${electronPath}) produced no payload — ${failures.join("; ")}`);
}

/**
 * Ask the Electron binary for the app's at-rest secret.
 *
 * The binary runs as Node (`ELECTRON_RUN_AS_NODE=1`) with an inline script
 * that emits the secret. See {@link runKeyHelper} for why the payload is
 * normally collected through a temp file rather than a pipe.
 *
 * @returns the canonical secret.
 * @throws when the helper cannot run or returns an unusable payload.
 */
async function readAtRestSecret() {
	const electronPath = resolveElectronPath();
	const text = await runKeyHelper(electronPath);
	const secret = parseAtRestPayload(text);
	if (secret === undefined) {
		throw new Error(
			"The WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey}).",
		);
	}
	return secret;
}

/**
 * Open an encrypted auth document into the plaintext text the regular parser reads.
 *
 * @param classification - an `encrypted` classification.
 * @returns the rebuilt plaintext document.
 * @throws when the key helper fails or a field will not open.
 */
async function unwrapDesktopAuthDocument(classification) {
	const wrapped = classification.wrapped;
	const secret = await readAtRestSecret();
	const key = deriveProtectorKey(secret);
	const resolvedKeyId = createHash("sha256").update(key).digest("hex").slice(0, 16);

	const requested = keyIdsOf(wrapped.fields);
	if (!requested.includes(resolvedKeyId)) {
		throw new Error(
			`WorkBuddy's current at-rest key (id ${resolvedKeyId}) does not match the credential's envelope (id ${requested.join(" or ")}); the credential was sealed by a different WorkBuddy installation. Open the WorkBuddy app once to reseal the sign-in.`,
		);
	}

	const rebuilt = structuredClone(wrapped.document);
	const auth = typeof rebuilt["auth"] === "object" && rebuilt["auth"] !== null ? rebuilt["auth"] : rebuilt;
	for (const field of wrapped.fields) {
		const plaintext = openAuthField(key, field.envelope);
		if (plaintext === undefined) {
			throw new Error(
				`The encrypted credential's ${field.field} could not be decrypted (envelope key id ${field.envelope.keyId}); the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in.`,
			);
		}
		auth[field.field] = plaintext;
	}
	return JSON.stringify(rebuilt);
}

/**
 * Parse a WorkBuddy auth document.
 *
 * Accepts both on-disk shapes: the nested `{"auth":{...},"account":{...}}`
 * form and a flat panel form where the token and identity share one level.
 *
 * @param text - plaintext auth-file contents.
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
 * the mainland endpoint is the only one that serves the search path.
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
 * Read the first usable WorkBuddy credential from the candidate paths,
 * decrypting the document when the app sealed it.
 *
 * A document this plugin can neither read as plaintext nor open as a sealed
 * envelope is reported rather than skipped: the desktop file is the identity
 * authority, and silently ignoring it would attribute the wrong account.
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

		const classification = classifyDesktopAuthDocument(text);
		if (classification.format === "absent") continue;
		if (classification.format === "unrecognized") {
			failures.push(
				`${path}: exists but is unreadable (neither a plaintext credential nor a decodable sealed envelope)`,
			);
			continue;
		}

		let plaintext = text;
		if (classification.format === "encrypted") {
			try {
				plaintext = await unwrapDesktopAuthDocument(classification);
			} catch (error) {
				failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
		}

		const credential = parseWorkBuddyAuth(plaintext);
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
