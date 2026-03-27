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

//! Build script for hyperlight-analysis host crate.
//!
//! This script:
//! 1. Builds the hyperlight-analysis-runtime guest binary
//! 2. Embeds the binary into the host crate
//! 3. Computes SHA256 hash for integrity verification
//! 4. Generates NAPI bindings

#![allow(clippy::disallowed_macros)]

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    // Set up NAPI build
    napi_build::setup();

    if env::var("DOCS_RS").is_ok() {
        // docs.rs runs offline, bundle an empty resource
        bundle_dummy();
        return;
    }

    let out_dir = env::var_os("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir).join("host_resource.rs");
    let _ = fs::remove_file(&dest_path);

    bundle_runtime();
}

fn resolve_runtime_manifest_path() -> PathBuf {
    // Use cargo metadata to find the runtime crate
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let output = std::process::Command::new(&cargo)
        .args(["metadata", "--format-version=1"])
        .output()
        .expect("Cargo is not installed or not found in PATH");

    assert!(
        output.status.success(),
        "Failed to get cargo metadata: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    #[derive(serde::Deserialize)]
    struct CargoMetadata {
        packages: Vec<CargoPackage>,
    }

    #[derive(serde::Deserialize)]
    struct CargoPackage {
        name: String,
        manifest_path: PathBuf,
    }

    let metadata: CargoMetadata =
        serde_json::from_slice(&output.stdout).expect("Failed to parse cargo metadata");

    let runtime = metadata
        .packages
        .into_iter()
        .find(|pkg| pkg.name == "hyperlight-analysis-runtime")
        .expect("hyperlight-analysis-runtime crate not found in cargo metadata");

    runtime.manifest_path
}

fn find_target_dir() -> PathBuf {
    let out_dir = env::var_os("OUT_DIR").unwrap();
    let out_dir = Path::new(&out_dir);
    let target = env::var("TARGET").unwrap();

    // out_dir is expected to be something like /path/to/target/(ARCH?)/debug/build/hyperlight-analysis-xxxx/out
    let target_dir = out_dir
        .ancestors()
        .nth(4)
        .expect("OUT_DIR does not have enough ancestors to find target directory");

    // If the target directory is named after the target triple, move up one more level
    if target_dir.file_name() == Some(target.as_str().as_ref())
        && let Some(parent) = target_dir.parent()
        && parent.join("CACHEDIR.TAG").exists()
    {
        return parent.to_path_buf();
    }

    target_dir.to_path_buf()
}

fn build_runtime() -> PathBuf {
    let profile = env::var_os("PROFILE").unwrap();

    let target_dir = find_target_dir();
    // Use a separate target directory to avoid deadlock
    let target_dir = target_dir.join("hyperlight-analysis-runtime");

    let manifest_path = resolve_runtime_manifest_path();

    assert!(
        manifest_path.is_file(),
        "expected hyperlight-analysis-runtime manifest path to be a Cargo.toml file, got {manifest_path:?}",
    );

    let runtime_dir = manifest_path
        .parent()
        .expect("expected manifest path to have a parent directory");

    println!("cargo:rerun-if-changed={}", runtime_dir.display());

    let cargo_profile = if profile == "debug" { "dev" } else { "release" };

    let stubs_inc = runtime_dir.join("include");
    let cflags = format!("-I{} -D__wasi__=1", stubs_inc.display());
    let cflags = cflags.replace('\\', "/");

    let mut cargo_cmd = cargo_hyperlight::cargo().unwrap();
    let cmd = cargo_cmd
        .arg("build")
        .arg("--profile")
        .arg(cargo_profile)
        .arg("-v")
        .arg("--target-dir")
        .arg(&target_dir)
        .arg("--manifest-path")
        .arg(&manifest_path)
        .arg("--locked")
        .env_clear_cargo()
        .env("HYPERLIGHT_CFLAGS", cflags);

    cmd.status().unwrap_or_else(|e| {
        panic!("Could not run `cargo build` for the analysis runtime: {e:?}\n{cmd:?}")
    });

    let resource = target_dir
        .join("x86_64-hyperlight-none")
        .join(&profile)
        .join("hyperlight-analysis-runtime");

    if let Ok(path) = resource.canonicalize() {
        path
    } else {
        panic!(
            "could not find hyperlight-analysis-runtime after building it (expected {:?})",
            resource
        )
    }
}

fn bundle_runtime() {
    let runtime_resource = build_runtime();
    let runtime_bytes = fs::read(&runtime_resource).expect("Failed to read runtime binary");

    // Compute SHA256 hash
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&runtime_bytes);
    let hash = hasher.finalize();
    let hash_hex = hex::encode(hash);

    let out_dir = env::var_os("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir).join("host_resource.rs");
    let contents = format!(
        r#"pub(crate) static ANALYSIS_RUNTIME: &[u8] = include_bytes!({runtime_resource:?});
pub(crate) const ANALYSIS_RUNTIME_SHA256: &str = "{hash_hex}";"#
    );

    fs::write(dest_path, contents).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}

fn bundle_dummy() {
    let out_dir = env::var_os("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir).join("host_resource.rs");
    let contents = r#"pub(crate) static ANALYSIS_RUNTIME: &[u8] = &[];
pub(crate) const ANALYSIS_RUNTIME_SHA256: &str = "";"#;
    fs::write(dest_path, contents).unwrap();
}
