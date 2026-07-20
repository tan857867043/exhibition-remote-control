use sysinfo::System;
fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();
    if let Some(host) = System::host_name() {
        println!("{}", host);
    }
}
