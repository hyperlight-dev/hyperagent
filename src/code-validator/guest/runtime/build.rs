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

//! Build script for hyperlight-analysis-runtime.
//!
//! Generates libc bindings for the Hyperlight guest environment.

use std::env;
use std::path::PathBuf;

use bindgen::RustEdition::Edition2024;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // picolibc's guest clock_gettime/gettimeofday are poor stubs; wrap them so our
    // __wrap_* overrides (stubs/clock.rs) supply a deterministic fixed timestamp.
    if std::env::var("CARGO_CFG_HYPERLIGHT").is_ok() {
        println!("cargo::rustc-link-arg=-wrap=clock_gettime");
        println!("cargo::rustc-link-arg=-wrap=gettimeofday");
    }

    let mut bindings = bindgen::builder()
        .use_core()
        .wrap_unsafe_ops(true)
        .rust_edition(Edition2024)
        .clang_arg("-D_POSIX_MONOTONIC_CLOCK=1")
        .clang_arg("-D_POSIX_C_SOURCE=200809L");

    bindings = bindings.header_contents(
        "libc.h",
        "
        #pragma once
        #include <errno.h>
        #include <stdio.h>
        #include <time.h>
        ",
    );

    println!("cargo:rerun-if-changed=include");
    println!("cargo:rerun-if-changed=include/stdio.h");
    println!("cargo:rerun-if-changed=include/time.h");
    println!("cargo:rerun-if-changed=include/unistd.h");

    // Write the generated bindings to an output file.
    let out_path = PathBuf::from(env::var("OUT_DIR")?).join("libc.rs");
    bindings.generate()?.write_to_file(out_path)?;

    Ok(())
}
