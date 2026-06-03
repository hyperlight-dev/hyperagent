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

//! Hyperlight sandbox management for the analysis guest.
//!
//! This module handles:
//! - Creating and managing Hyperlight micro-VM instances
//! - Dispatching function calls to the guest
//! - Resource limits and timeouts
//!
//! # Thread Safety
//!
//! The sandbox is created per-call for now to ensure isolation.
//! Future optimization: pool sandboxes for repeated calls.
//!
//! # Runtime
//!
//! Uses an explicit Tokio runtime (from `runtime.rs`) instead of napi-rs's
//! implicit runtime to avoid conflicts with other native addons.

use hyperlight_host::sandbox::SandboxConfiguration;
use hyperlight_host::sandbox::uninitialized::GuestBinary;
use hyperlight_host::{MultiUseSandbox, UninitializedSandbox};
use napi::bindgen_prelude::*;

use crate::ANALYSIS_RUNTIME;
use crate::runtime::get_analysis_runtime;

/// Heap size for the guest (16 MB).
const GUEST_HEAP_SIZE: u64 = 16 * 1024 * 1024;

/// Scratch size for the guest (16 MB).
/// QuickJS needs scratch space for the stack and runtime initialization.
const GUEST_SCRATCH_SIZE: usize = 16 * 1024 * 1024;

/// Input buffer size (4 MB) - for passing code + context to guest.
const GUEST_INPUT_SIZE: usize = 4 * 1024 * 1024;

/// Output buffer size (4 MB) - for returning validation results from guest.
const GUEST_OUTPUT_SIZE: usize = 4 * 1024 * 1024;

/// Call a function in the analysis guest.
///
/// Creates a new sandbox instance, calls the function, and tears down.
/// This ensures complete isolation between calls.
///
/// # Arguments
///
/// * `function_name` - Name of the guest function to call
/// * `input` - JSON string input for the function
///
/// # Returns
///
/// JSON string output from the guest function.
///
/// # Errors
///
/// Returns an error if:
/// - Runtime not available
/// - Sandbox creation fails (hypervisor not available)
/// - Guest function call fails
/// - Timeout exceeded
pub async fn call_guest_function(function_name: &str, input: String) -> Result<String> {
    let function_name = function_name.to_string();

    let handle = get_analysis_runtime()
        .ok_or_else(|| Error::new(Status::GenericFailure, "Analysis runtime not available"))?;

    // Run the blocking Hyperlight operations on the runtime's thread pool
    handle
        .spawn_blocking(move || call_guest_function_sync(&function_name, input))
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Task join error: {e}")))?
}

/// Call a function in the analysis guest with two string parameters.
///
/// Similar to `call_guest_function` but passes two separate string arguments.
/// Used for functions like `validate_javascript(source, context_json)`.
pub async fn call_guest_function_2(
    function_name: &str,
    input1: String,
    input2: String,
) -> Result<String> {
    let function_name = function_name.to_string();

    let handle = get_analysis_runtime()
        .ok_or_else(|| Error::new(Status::GenericFailure, "Analysis runtime not available"))?;

    // Run the blocking Hyperlight operations on the runtime's thread pool
    handle
        .spawn_blocking(move || call_guest_function_2_sync(&function_name, input1, input2))
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Task join error: {e}")))?
}

/// Synchronous implementation of guest function call.
fn call_guest_function_sync(function_name: &str, input: String) -> Result<String> {
    // Configure the sandbox with resource limits
    let mut config = SandboxConfiguration::default();
    config.set_heap_size(GUEST_HEAP_SIZE);
    config.set_scratch_size(GUEST_SCRATCH_SIZE);
    config.set_input_data_size(GUEST_INPUT_SIZE);
    config.set_output_data_size(GUEST_OUTPUT_SIZE);

    // Create the guest binary from embedded bytes
    let guest_binary = GuestBinary::Buffer(ANALYSIS_RUNTIME);

    // Create uninitialized sandbox
    let uninitialized = UninitializedSandbox::new(guest_binary, Some(config)).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Sandbox creation failed: {e}"),
        )
    })?;

    // Initialize the sandbox (calls hyperlight_main)
    let mut sandbox: MultiUseSandbox = uninitialized
        .evolve()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Sandbox init failed: {e}")))?;

    // Call the guest function
    let result: String = sandbox
        .call(function_name, (input,))
        .map_err(|e| Error::new(Status::GenericFailure, format!("Guest call failed: {e}")))?;

    Ok(result)
}

/// Synchronous implementation of guest function call with two parameters.
fn call_guest_function_2_sync(
    function_name: &str,
    input1: String,
    input2: String,
) -> Result<String> {
    let mut config = SandboxConfiguration::default();
    config.set_heap_size(GUEST_HEAP_SIZE);
    config.set_scratch_size(GUEST_SCRATCH_SIZE);
    config.set_input_data_size(GUEST_INPUT_SIZE);
    config.set_output_data_size(GUEST_OUTPUT_SIZE);

    let guest_binary = GuestBinary::Buffer(ANALYSIS_RUNTIME);

    let uninitialized = UninitializedSandbox::new(guest_binary, Some(config)).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Sandbox creation failed: {e}"),
        )
    })?;

    let mut sandbox: MultiUseSandbox = uninitialized
        .evolve()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Sandbox init failed: {e}")))?;

    let result: String = sandbox
        .call(function_name, (input1, input2))
        .map_err(|e| Error::new(Status::GenericFailure, format!("Guest call failed: {e}")))?;

    Ok(result)
}

/// Check if Hyperlight is available on this system.
///
/// Returns information about the available hypervisor backend.
#[allow(dead_code)]
pub fn check_hyperlight_availability() -> Result<String> {
    // Try to determine which hypervisor is available
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/dev/kvm").exists() {
            return Ok("kvm".to_string());
        }
        if std::path::Path::new("/dev/mshv").exists() {
            return Ok("mshv".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // WHP is always available on Windows 10+
        Ok("whp".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    Err(Error::new(
        Status::GenericFailure,
        "No hypervisor backend available. Ensure KVM, MSHV, or WHP is enabled.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_hyperlight_availability() {
        // This test just verifies the function doesn't panic
        let _ = check_hyperlight_availability();
    }
}
