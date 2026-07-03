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

//! Clock function stubs for rquickjs.
//!
//! For the analysis guest, we don't need accurate time - we just need
//! the functions to exist so QuickJS can link. We return a fixed timestamp.

use crate::libc;

/// Fixed timestamp: 2024-01-01 00:00:00 UTC in microseconds since epoch.
const FIXED_TIMESTAMP_MICROS: u64 = 1704067200u64 * 1_000_000u64;

// picolibc provides clock_gettime/gettimeofday, but as poor guest stubs. The build
// script sets `-wrap=clock_gettime` / `-wrap=gettimeofday`, redirecting calls here so
// we return a deterministic fixed timestamp (the analysis guest needs no real time).
#[unsafe(no_mangle)]
extern "C" fn __wrap_clock_gettime(clk_id: libc::clockid_t, ts: *mut libc::timespec) -> libc::c_int {
    const CLOCK_REALTIME: libc::clockid_t = libc::CLOCK_REALTIME as libc::clockid_t;
    const CLOCK_MONOTONIC: libc::clockid_t = libc::CLOCK_MONOTONIC as libc::clockid_t;

    if clk_id != CLOCK_REALTIME && clk_id != CLOCK_MONOTONIC {
        unsafe { libc::errno = libc::EINVAL as _ };
        return -1;
    }

    let micros = FIXED_TIMESTAMP_MICROS;
    unsafe {
        ts.write(libc::timespec {
            tv_sec: (micros / 1_000_000) as _,
            tv_nsec: ((micros % 1_000_000) * 1000) as _,
        })
    };
    0
}

#[unsafe(no_mangle)]
extern "C" fn __wrap_gettimeofday(tp: *mut libc::timeval, _tz: *mut libc::c_void) -> libc::c_int {
    let micros = FIXED_TIMESTAMP_MICROS;
    unsafe {
        tp.write(libc::timeval {
            tv_sec: (micros / 1_000_000) as _,
            tv_usec: (micros % 1_000_000) as _,
        });
    }
    0
}
