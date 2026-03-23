#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    secretary_native_lib::run();
}
