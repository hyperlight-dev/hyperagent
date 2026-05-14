/*
Copyright 2026  The Hyperlight Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
//! Explicit Tokio runtime for hyperlight-analysis.
//!
//! Using an explicit runtime avoids conflicts with napi-rs's implicit runtime
//! and other native addons (like hyperlight-js) that may also create runtimes.
//!
//! This approach fixes SIGSEGV crashes caused by race conditions between
//! multiple tokio runtimes competing for async task execution.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::runtime::{Handle, Runtime};

/// Environment variable to configure the number of worker threads.
pub(crate) const ENV_ANALYSIS_THREADS: &str = "HYPERLIGHT_ANALYSIS_THREADS";

/// Default number of worker threads.
const DEFAULT_WORKERS: usize = 2;

/// Maximum number of blocking threads.
/// Hyperlight sandbox calls are blocking, so we limit this to prevent
/// thread explosion. Each concurrent validation/metadata call uses one thread.
const MAX_BLOCKING_THREADS: usize = 8;

/// Timeout for graceful runtime shutdown.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Check whether verbose/debug output is enabled via env vars.
/// Returns true if HYPERAGENT_VERBOSE=1 or HYPERAGENT_DEBUG=1.
fn is_verbose() -> bool {
    std::env::var("HYPERAGENT_VERBOSE")
        .map(|v| v == "1")
        .unwrap_or(false)
        || std::env::var("HYPERAGENT_DEBUG")
            .map(|v| v == "1")
            .unwrap_or(false)
}

/// Shared Tokio runtime for all analysis operations.
///
/// Uses `OnceLock<Mutex<Option<Runtime>>>` instead of `LazyLock<Option<Runtime>>`
/// to allow taking ownership for explicit shutdown. This prevents SIGSEGV on
/// process exit caused by Rust TLS destructors racing with Node's exit handlers.
static ANALYSIS_RUNTIME: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();

/// Initialize the runtime (called on first access).
fn init_runtime() -> Mutex<Option<Runtime>> {
    let workers = std::env::var(ENV_ANALYSIS_THREADS)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_WORKERS);

    match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .max_blocking_threads(MAX_BLOCKING_THREADS)
        .thread_name("hl-analysis")
        .build()
    {
        Ok(rt) => {
            if is_verbose() {
                eprintln!(
                    "[hyperlight-analysis] Initialized runtime with {} workers",
                    workers
                );
            }
            Mutex::new(Some(rt))
        }
        Err(e) => {
            eprintln!(
                "[hyperlight-analysis] Failed to create runtime: {}. Analysis will fail.",
                e
            );
            Mutex::new(None)
        }
    }
}

/// Get a handle to the shared analysis runtime.
///
/// Returns `None` if runtime creation failed or if it was already shut down.
/// The Handle is Clone and can be used without holding the Mutex.
pub(crate) fn get_analysis_runtime() -> Option<Handle> {
    let guard = ANALYSIS_RUNTIME.get_or_init(init_runtime).lock().ok()?;
    guard.as_ref().map(|rt| rt.handle().clone())
}

/// Explicitly shutdown the analysis runtime.
///
/// This must be called before `process.exit()` to prevent SIGSEGV from
/// Rust TLS destructors racing with Node's exit handlers.
///
/// After calling this, `get_analysis_runtime()` will return `None`.
pub(crate) fn shutdown_runtime() {
    if let Some(mutex) = ANALYSIS_RUNTIME.get()
        && let Ok(mut guard) = mutex.lock()
        && let Some(rt) = guard.take()
    {
        if is_verbose() {
            eprintln!("[hyperlight-analysis] Shutting down runtime...");
        }
        rt.shutdown_timeout(SHUTDOWN_TIMEOUT);
        if is_verbose() {
            eprintln!("[hyperlight-analysis] Runtime shutdown complete");
        }
    }
}
