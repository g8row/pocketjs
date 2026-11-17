//! Links src/compat.c: the C23 math symbols (`fmaximum_numf`, …) LLVM lowers
//! `f32::max/min` to are missing from bionic's libm at the API levels this
//! host targets (24 = Android 7.0), so provide them for Android builds only.

fn main() {
    println!("cargo:rerun-if-changed=src/compat.c");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "android" {
        cc::Build::new().file("src/compat.c").compile("android_compat");
    }
}
