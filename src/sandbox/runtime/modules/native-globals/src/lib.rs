//! Native globals — TextEncoder, TextDecoder, atob, btoa, crypto, console extras.
//!
//! Registers standard Web API globals that npm libraries expect.
//! Called via `custom_globals!` macro during runtime init.
//!
//! Core encoding logic is in Rust for performance and correctness.
//! JS constructor wrappers call into the Rust functions.
//!
//! crypto.getRandomValues and crypto.randomUUID use a xorshift128+
//! PRNG seeded from a hash of the compilation timestamp. This is NOT
//! cryptographically secure — it's for awk rand(), UUID generation,
//! and similar non-security uses.

#![cfg_attr(hyperlight, no_std)]

#[cfg(hyperlight)]
extern crate alloc;

#[cfg(hyperlight)]
use alloc::string::String;
#[cfg(hyperlight)]
use alloc::vec::Vec;

use rquickjs::{Ctx, Function, Result as QjsResult, TypedArray};
use core::sync::atomic::{AtomicU64, Ordering};
use digest::Digest;

// ── TextEncoder ─────────────────────────────────────────────────────────
//
// Implements the WHATWG Encoding API TextEncoder.
// encode() converts a JS string to UTF-8 bytes (Uint8Array).
// Rust strings are always valid UTF-8, so into_bytes() is zero-cost.

fn text_encoder_encode<'js>(ctx: Ctx<'js>, input: String) -> QjsResult<TypedArray<'js, u8>> {
    TypedArray::new(ctx, input.into_bytes())
}

// ── TextDecoder ─────────────────────────────────────────────────────────
//
// Implements the WHATWG Encoding API TextDecoder (UTF-8 only).
// decode() converts a Uint8Array to a JS string.

fn text_decoder_decode(input: Vec<u8>) -> QjsResult<String> {
    String::from_utf8(input)
        .map_err(|_| rquickjs::Error::new_from_js("bytes", "valid UTF-8 string"))
}

// ── atob / btoa ─────────────────────────────────────────────────────────
//
// Standard base64 encode/decode matching browser behavior.
// atob: base64 string → decoded Latin-1 string
// btoa: Latin-1 string (chars 0-255) → base64 string

const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_decode_char(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn rust_atob(encoded: String) -> QjsResult<String> {
    // Strip whitespace (browsers are lenient)
    let clean: Vec<u8> = encoded
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();

    let mut bytes = Vec::new();
    let mut i = 0;
    while i < clean.len() {
        let a = b64_decode_char(clean[i])
            .ok_or_else(|| rquickjs::Error::new_from_js("string", "valid base64"))?;
        let b = if i + 1 < clean.len() {
            b64_decode_char(clean[i + 1]).unwrap_or(0)
        } else {
            0
        };
        let c = if i + 2 < clean.len() && clean[i + 2] != b'=' {
            b64_decode_char(clean[i + 2]).unwrap_or(0)
        } else {
            0
        };
        let d = if i + 3 < clean.len() && clean[i + 3] != b'=' {
            b64_decode_char(clean[i + 3]).unwrap_or(0)
        } else {
            0
        };

        bytes.push((a << 2) | (b >> 4));
        if i + 2 < clean.len() && clean[i + 2] != b'=' {
            bytes.push(((b & 0x0F) << 4) | (c >> 2));
        }
        if i + 3 < clean.len() && clean[i + 3] != b'=' {
            bytes.push(((c & 0x03) << 6) | d);
        }

        i += 4;
    }

    // atob returns Latin-1 string (each byte becomes a char)
    Ok(bytes.iter().map(|&b| b as char).collect())
}

fn rust_btoa(input: String) -> QjsResult<String> {
    // Validate all chars are 0-255 (Latin-1)
    for c in input.chars() {
        if c as u32 > 255 {
            return Err(rquickjs::Error::new_from_js(
                "string",
                "Latin1 string (all characters must be 0-255)",
            ));
        }
    }

    let bytes: Vec<u8> = input.bytes().collect();
    let mut result = String::new();

    let mut i = 0;
    while i < bytes.len() {
        let a = bytes[i];
        let b = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let c = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };

        result.push(B64_CHARS[(a >> 2) as usize] as char);
        result.push(B64_CHARS[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);

        if i + 1 < bytes.len() {
            result.push(B64_CHARS[(((b & 0x0F) << 2) | (c >> 6)) as usize] as char);
        } else {
            result.push('=');
        }

        if i + 2 < bytes.len() {
            result.push(B64_CHARS[(c & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    Ok(result)
}

// ── Hardware RNG (RDRAND / RDSEED) ───────────────────────────────────
//
// x86_64 CPUs provide hardware random number generation via RDRAND
// (random numbers) and RDSEED (entropy seed). Since we run in a
// Hyperlight micro-VM on x86_64, these instructions are available
// directly — no OS, no crate, no software PRNG needed.
//
// Used by crypto.getRandomValues, crypto.randomUUID, and Math.random.

/// Read a hardware random u64 via RDRAND. Retries on transient failure.
#[inline]
fn rdrand64() -> u64 {
    let mut val: u64;
    let mut ok: u8;
    // RDRAND can fail if the HW buffer is exhausted — retry up to 10 times
    for _ in 0..10 {
        unsafe {
            core::arch::asm!(
                "rdrand {val}",
                "setc {ok}",
                val = out(reg) val,
                ok = out(reg_byte) ok,
                options(nostack, nomem),
            );
        }
        if ok != 0 {
            return val;
        }
    }
    // Fallback: should never happen on modern CPUs, but don't panic
    // in production code. Return a non-zero value based on a counter.
    static FALLBACK: AtomicU64 = AtomicU64::new(0xDEAD_BEEF_CAFE_BABE);
    FALLBACK.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
}

/// Fill a Uint8Array with hardware random bytes via RDRAND.
fn crypto_get_random_values<'js>(
    ctx: Ctx<'js>,
    input: TypedArray<'js, u8>,
) -> QjsResult<TypedArray<'js, u8>> {
    let len = input.len();
    let mut bytes = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        let val = rdrand64();
        let val_bytes = val.to_le_bytes();
        for &b in &val_bytes {
            if i >= len {
                break;
            }
            bytes.push(b);
            i += 1;
        }
    }
    let result = TypedArray::new(ctx, bytes)?;
    Ok(result)
}

/// Generate a v4 UUID string using RDRAND.
fn crypto_random_uuid() -> QjsResult<String> {
    let r1 = rdrand64();
    let r2 = rdrand64();
    // Set version (4) and variant (10xx) bits per RFC 4122
    let time_hi = ((r1 >> 32) as u16 & 0x0FFF) | 0x4000; // version 4
    let clock_seq = ((r2 >> 48) as u16 & 0x3FFF) | 0x8000; // variant 10xx

    Ok(alloc::format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (r1 & 0xFFFF_FFFF) as u32,
        ((r1 >> 32) & 0xFFFF) as u16,
        time_hi,
        clock_seq,
        r2 & 0xFFFF_FFFF_FFFF
    ))
}

/// Generate a random f64 in [0, 1) — used by Math.random.
/// Hardware RDRAND provides true randomness, not a PRNG sequence.
fn math_random() -> QjsResult<f64> {
    let r = rdrand64();
    // Use upper 53 bits for full double precision
    Ok((r >> 11) as f64 / (1u64 << 53) as f64)
}

// ── crypto.subtle.digest (SHA-1 / SHA-256) ──────────────────────────
//
// Implements the SubtleCrypto.digest() API needed by just-bash's
// sha1sum and sha256sum commands. Uses RustCrypto crates (no_std,
// audited) — not hand-rolled.
//
// API: crypto.subtle.digest(algorithm, data) → ArrayBuffer
//   algorithm: "SHA-1" or "SHA-256"
//   data: Uint8Array (or ArrayBuffer view)
//   returns: Uint8Array containing the hash bytes

/// Compute SHA-1 or SHA-256 digest. Called from JS via crypto.subtle.digest().
fn crypto_subtle_digest<'js>(
    ctx: Ctx<'js>,
    algorithm: String,
    data: Vec<u8>,
) -> QjsResult<TypedArray<'js, u8>> {
    let hash_bytes: Vec<u8> = match algorithm.as_str() {
        "SHA-1" => {
            let mut hasher = sha1::Sha1::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        "SHA-256" => {
            let mut hasher = sha2::Sha256::new();
            hasher.update(&data);
            hasher.finalize().to_vec()
        }
        _ => {
            return Err(rquickjs::Error::new_from_js(
                "string",
                "supported algorithm (SHA-1 or SHA-256)",
            ));
        }
    };
    TypedArray::new(ctx, hash_bytes)
}

// ── Public setup function ────────────────────────────────────────────────
//
// Called by custom_globals! macro during runtime init.
// Registers TextEncoder, TextDecoder, atob, btoa, console extras,
// and queueMicrotask as globals.

pub fn setup_globals(ctx: &Ctx<'_>) -> QjsResult<()> {
    let globals = ctx.globals();

    // ── TextEncoder constructor ──────────────────────────────────
    // Rust function handles the UTF-8 encoding, JS wraps it in a constructor.
    // We capture the Rust fn in a closure so it survives cleanup.
    let encode_fn = Function::new(ctx.clone(), text_encoder_encode)?;
    globals.set("__ha_encode", encode_fn)?;
    ctx.eval::<(), _>(
        r#"
        (function() {
            const encode = globalThis.__ha_encode;
            globalThis.TextEncoder = function TextEncoder() {
                this.encoding = "utf-8";
                this.encode = function(input) {
                    return encode(String(input === undefined || input === null ? "" : input));
                };
                this.encodeInto = function(source, destination) {
                    const encoded = this.encode(source);
                    const len = Math.min(encoded.length, destination.length);
                    destination.set(encoded.subarray(0, len));
                    return { read: source.length, written: len };
                };
            };
            delete globalThis.__ha_encode;
        })();
    "#,
    )?;

    // ── TextDecoder constructor ──────────────────────────────────
    // Rust function handles the UTF-8 decoding, JS wraps it.
    let decode_fn = Function::new(ctx.clone(), text_decoder_decode)?;
    globals.set("__ha_decode", decode_fn)?;
    ctx.eval::<(), _>(r#"
        (function() {
            const decode = globalThis.__ha_decode;
            globalThis.TextDecoder = function TextDecoder(label, options) {
                const enc = (label || "utf-8").toLowerCase();
                if (enc !== "utf-8" && enc !== "utf8") {
                    throw new RangeError("Only UTF-8 encoding is supported");
                }
                this.encoding = "utf-8";
                this.fatal = !!(options && options.fatal);
                this.decode = function(input) {
                    if (input === undefined || input === null) return "";
                    const bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input.buffer || input);
                    return decode(Array.from(bytes));
                };
            };
            delete globalThis.__ha_decode;
        })();
    "#)?;

    // ── atob / btoa ──────────────────────────────────────────────
    let atob_fn = Function::new(ctx.clone(), rust_atob)?;
    let btoa_fn = Function::new(ctx.clone(), rust_btoa)?;
    globals.set("atob", atob_fn)?;
    globals.set("btoa", btoa_fn)?;

    // ── console.warn/error/info/debug ────────────────────────────
    // Alias to console.log since the sandbox has no stderr distinction.
    // Works because hyperlight-js now creates console as an extensible
    // plain Object (not a frozen module namespace) and freezes it AFTER
    // custom_globals! runs.
    ctx.eval::<(), _>(r#"
        if (typeof globalThis.console === 'object' && typeof globalThis.console.log === 'function') {
            globalThis.console.warn = globalThis.console.log;
            globalThis.console.error = globalThis.console.log;
            globalThis.console.info = globalThis.console.log;
            globalThis.console.debug = globalThis.console.log;
        }
    "#)?;

    // ── queueMicrotask ──────────────────────────────────────────
    ctx.eval::<(), _>(
        r#"
        if (typeof globalThis.queueMicrotask === 'undefined') {
            globalThis.queueMicrotask = function(fn) {
                Promise.resolve().then(fn);
            };
        }
    "#,
    )?;

    // ── crypto.getRandomValues + crypto.randomUUID ──────────────
    // Backed by x86_64 RDRAND hardware instruction — true randomness.
    let get_random_values_fn = Function::new(ctx.clone(), crypto_get_random_values)?;
    let random_uuid_fn = Function::new(ctx.clone(), crypto_random_uuid)?;
    let subtle_digest_fn = Function::new(ctx.clone(), crypto_subtle_digest)?;
    globals.set("__ha_getRandomValues", get_random_values_fn)?;
    globals.set("__ha_randomUUID", random_uuid_fn)?;
    globals.set("__ha_subtleDigest", subtle_digest_fn)?;
    ctx.eval::<(), _>(r#"
        (function() {
            const getRandomValues = globalThis.__ha_getRandomValues;
            const randomUUID = globalThis.__ha_randomUUID;
            const subtleDigest = globalThis.__ha_subtleDigest;
            if (typeof globalThis.crypto === 'undefined') {
                globalThis.crypto = {};
            }
            globalThis.crypto.getRandomValues = function(array) {
                const filled = getRandomValues(array);
                for (let i = 0; i < array.length; i++) array[i] = filled[i];
                return array;
            };
            globalThis.crypto.randomUUID = randomUUID;
            // SubtleCrypto.digest — returns Promise<ArrayBuffer> matching the Web API.
            // Backed by RustCrypto sha1/sha2 crates (no_std, audited).
            globalThis.crypto.subtle = {
                digest: function(algorithm, data) {
                    try {
                        const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);
                        const result = subtleDigest(algorithm, Array.from(bytes));
                        return Promise.resolve(result.buffer);
                    } catch (e) {
                        return Promise.reject(e);
                    }
                }
            };
            delete globalThis.__ha_getRandomValues;
            delete globalThis.__ha_randomUUID;
            delete globalThis.__ha_subtleDigest;
        })();
    "#)?;

    // ── Math.random (PRNG-backed) ────────────────────────────────
    // Override QuickJS's built-in Math.random with our seeded PRNG
    // so awk rand() and other random functions produce varied output.
    let math_random_fn = Function::new(ctx.clone(), math_random)?;
    globals.set("__ha_mathRandom", math_random_fn)?;
    ctx.eval::<(), _>(r#"
        (function() {
            Math.random = globalThis.__ha_mathRandom;
            delete globalThis.__ha_mathRandom;
        })();
    "#)?;

    Ok(())
}
