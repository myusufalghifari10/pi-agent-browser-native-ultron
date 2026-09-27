// local patch: RFC 6238 TOTP so the vault can answer 2FA prompts without the user.
// Upstream agent-browser has no TOTP support (its own docs tell users to complete 2FA by
// hand), so this lives wrapper-side and only ever returns a one-time code, never the seed.
import { createHmac, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_VALUES = new Map([...BASE32_ALPHABET].map((character, index) => [character, index]));
const TOTP_DEFAULT_DIGITS = 6;
const TOTP_DEFAULT_PERIOD_SECONDS = 30;
const TOTP_DEFAULT_ALGORITHM = "SHA1";
const TOTP_SUPPORTED_ALGORITHMS = new Set(["SHA1", "SHA256", "SHA512"]);
const TOTP_MIN_DIGITS = 1;
const TOTP_MAX_DIGITS = 10;
const TOTP_MAX_PERIOD_SECONDS = 300;
const TOTP_COUNTER_BYTES = 8;
const TOTP_MAX_WINDOW = 10;

/** Typed failures keep wrong-seed and wrong-option paths distinguishable without leaking input. */
function totpError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * Base32 (RFC 4648) decoder. `otpauth://` seeds are shown to users with spaces and
 * lowercase, and padding is optional, so accept all of that instead of rejecting realistic input.
 * An empty or padding-only string decodes to an empty Buffer (documented behaviour).
 */
export function decodeBase32(input) {
    if (typeof input !== "string")
        throw totpError("invalid_base32", "Base32 input must be a string.");
    const compacted = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
    let bitBuffer = 0;
    let bitCount = 0;
    const bytes = [];
    for (const character of compacted) {
        const value = BASE32_VALUES.get(character);
        if (value === undefined)
            throw totpError("invalid_base32", "Base32 input contains a character outside the RFC 4648 alphabet.");
        bitBuffer = (bitBuffer << 5) | value;
        bitCount += 5;
        if (bitCount >= 8) {
            bitCount -= 8;
            bytes.push((bitBuffer >> bitCount) & 0xff);
        }
    }
    return Buffer.from(bytes);
}

function normalizeDigits(rawDigits) {
    if (rawDigits === undefined)
        return TOTP_DEFAULT_DIGITS;
    const digits = Number(rawDigits);
    if (!Number.isInteger(digits) || digits < TOTP_MIN_DIGITS || digits > TOTP_MAX_DIGITS)
        throw totpError("invalid_totp_options", `TOTP digits must be an integer between ${TOTP_MIN_DIGITS} and ${TOTP_MAX_DIGITS}.`);
    return digits;
}

function normalizePeriod(rawPeriod) {
    if (rawPeriod === undefined)
        return TOTP_DEFAULT_PERIOD_SECONDS;
    const period = Number(rawPeriod);
    if (!Number.isInteger(period) || period < 1 || period > TOTP_MAX_PERIOD_SECONDS)
        throw totpError("invalid_totp_options", `TOTP period must be an integer between 1 and ${TOTP_MAX_PERIOD_SECONDS} seconds.`);
    return period;
}

function normalizeAlgorithm(rawAlgorithm) {
    if (rawAlgorithm === undefined)
        return TOTP_DEFAULT_ALGORITHM;
    const algorithm = String(rawAlgorithm).trim().toUpperCase();
    if (!TOTP_SUPPORTED_ALGORITHMS.has(algorithm))
        throw totpError("invalid_totp_options", "TOTP algorithm must be one of SHA1, SHA256, or SHA512.");
    return algorithm;
}

function normalizeTimestamp(rawTimestamp) {
    const timestamp = Number(rawTimestamp);
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function decodeSecret(secret) {
    if (typeof secret !== "string")
        throw totpError("invalid_base32", "TOTP secret must be a Base32 string.");
    const key = decodeBase32(secret);
    // A zero-length HMAC key would silently produce valid-looking codes for every seed,
    // so an empty seed fails loudly instead of authenticating the wrong thing.
    if (key.length === 0)
        throw totpError("invalid_totp_secret", "TOTP secret decodes to zero bytes.");
    return key;
}

function counterBuffer(counter) {
    const buffer = Buffer.alloc(TOTP_COUNTER_BYTES);
    buffer.writeBigUInt64BE(BigInt(counter));
    return buffer;
}

/** HOTP step (RFC 4226) with dynamic truncation, shared by generate and verify. */
function hotpCode(key, counter, digits, algorithm) {
    const digest = createHmac(algorithm.toLowerCase(), key).update(counterBuffer(counter)).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % 10 ** digits).padStart(digits, "0");
}

function counterForTimestamp(timestamp, period) {
    return Math.floor(timestamp / 1000 / period);
}

/**
 * Parse an `otpauth://totp/...` URI. Counter-based `otpauth://hotp/` seeds are not
 * supported (they need server-side counter state), so they intentionally return undefined.
 */
export function parseOtpauthUri(uri) {
    if (typeof uri !== "string")
        return undefined;
    const trimmed = uri.trim();
    if (!/^otpauth:\/\//i.test(trimmed) || /^otpauth:\/\/hotp\//i.test(trimmed))
        return undefined;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return undefined;
    }
    if (parsed.host.toLowerCase() !== "totp")
        return undefined;
    const rawSecret = parsed.searchParams.get("secret");
    const secret = rawSecret ? rawSecret.replace(/[\s-]/g, "").toUpperCase() : "";
    try {
        decodeSecret(secret);
    }
    catch {
        return undefined;
    }
    let label = parsed.pathname.replace(/^\/+/, "");
    try {
        label = decodeURIComponent(label);
    }
    catch {
        // Keep the raw label when percent-decoding fails; the label is metadata only.
    }
    const separatorIndex = label.lastIndexOf(":");
    const labelIssuer = separatorIndex === -1 ? undefined : label.slice(0, separatorIndex).trim();
    const account = (separatorIndex === -1 ? label : label.slice(separatorIndex + 1)).trim();
    const issuer = parsed.searchParams.get("issuer")?.trim() || labelIssuer;
    const rawDigits = parsed.searchParams.get("digits");
    const rawPeriod = parsed.searchParams.get("period");
    const rawAlgorithm = parsed.searchParams.get("algorithm");
    let digits = TOTP_DEFAULT_DIGITS;
    let period = TOTP_DEFAULT_PERIOD_SECONDS;
    let algorithm = TOTP_DEFAULT_ALGORITHM;
    try {
        digits = normalizeDigits(rawDigits === null ? undefined : Number(rawDigits));
    }
    catch {
        digits = TOTP_DEFAULT_DIGITS;
    }
    try {
        period = normalizePeriod(rawPeriod === null ? undefined : Number(rawPeriod));
    }
    catch {
        period = TOTP_DEFAULT_PERIOD_SECONDS;
    }
    try {
        algorithm = normalizeAlgorithm(rawAlgorithm === null ? undefined : rawAlgorithm);
    }
    catch {
        algorithm = TOTP_DEFAULT_ALGORITHM;
    }
    const result = { secret, digits, period, algorithm };
    if (issuer)
        result.issuer = issuer;
    if (account)
        result.account = account;
    return result;
}

/**
 * Current TOTP for a Base32 seed. `at` is accepted so callers (and tests) can ask for any
 * point in time; invalid seeds and option ranges throw typed errors rather than returning a
 * wrong code, because a silently wrong 2FA code is worse than a visible failure.
 */
export function generateTotp(secret, { digits = TOTP_DEFAULT_DIGITS, period = TOTP_DEFAULT_PERIOD_SECONDS, algorithm = TOTP_DEFAULT_ALGORITHM, at = Date.now() } = {}) {
    const key = decodeSecret(secret);
    const normalizedDigits = normalizeDigits(digits);
    const normalizedPeriod = normalizePeriod(period);
    const normalizedAlgorithm = normalizeAlgorithm(algorithm);
    const timestamp = normalizeTimestamp(at);
    const counter = counterForTimestamp(timestamp, normalizedPeriod);
    if (counter < 0)
        throw totpError("invalid_totp_options", "TOTP timestamp must not resolve to a negative counter.");
    const code = hotpCode(key, counter, normalizedDigits, normalizedAlgorithm);
    const elapsedSeconds = Math.floor(timestamp / 1000) % normalizedPeriod;
    return {
        code,
        remainingSeconds: normalizedPeriod - elapsedSeconds,
        counter,
        period: normalizedPeriod,
        digits: normalizedDigits,
    };
}

/**
 * Verify a user-supplied code across +/- `window` steps. Returns false for every malformed
 * input instead of throwing, and compares with a constant-time primitive so a caller cannot
 * learn the expected code from timing.
 */
export function verifyTotp(secret, code, { digits = TOTP_DEFAULT_DIGITS, period = TOTP_DEFAULT_PERIOD_SECONDS, algorithm = TOTP_DEFAULT_ALGORITHM, window = 1, at = Date.now() } = {}) {
    if (typeof code !== "string")
        return false;
    const candidate = code.replace(/\s/g, "");
    if (!/^\d+$/.test(candidate))
        return false;
    let key;
    let normalizedDigits;
    let normalizedPeriod;
    let normalizedAlgorithm;
    let stepWindow;
    try {
        key = decodeSecret(secret);
        normalizedDigits = normalizeDigits(digits);
        normalizedPeriod = normalizePeriod(period);
        normalizedAlgorithm = normalizeAlgorithm(algorithm);
        stepWindow = Math.min(Math.abs(Number.isInteger(window) ? window : 1), TOTP_MAX_WINDOW);
    }
    catch {
        return false;
    }
    if (candidate.length !== normalizedDigits)
        return false;
    const timestamp = normalizeTimestamp(at);
    const baseCounter = counterForTimestamp(timestamp, normalizedPeriod);
    if (baseCounter < 0 || baseCounter - stepWindow < 0)
        return false;
    const candidateBuffer = Buffer.from(candidate, "utf8");
    let matched = 0;
    for (let offset = -stepWindow; offset <= stepWindow; offset += 1) {
        const expected = hotpCode(key, baseCounter + offset, normalizedDigits, normalizedAlgorithm);
        const expectedBuffer = Buffer.from(expected, "utf8");
        matched |= timingSafeEqual(candidateBuffer, expectedBuffer) ? 1 : 0;
    }
    return matched === 1;
}

export function formatTotpRemaining(remainingSeconds) {
    const seconds = Number(remainingSeconds);
    if (!Number.isFinite(seconds))
        return "0s";
    return `${Math.max(0, Math.floor(seconds))}s`;
}
