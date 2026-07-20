use sysinfo::{System, Networks};

fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu = sys.cpus().first().map(|c| c.brand()).unwrap_or("Unknown CPU");
    let mem = sys.total_memory();
    let os_ver = System::os_version().unwrap_or_default();
    
    let networks = Networks::new_with_sysinfo();
    let mut ip = String::new();
    let mut mac = String::new();
    for (name, data) in &networks {
        if name != "lo" && !name.starts_with("Loopback") {
            for nw in data.ip_networks() {
                ip = format!("{:?}", nw);
            }
            mac = format!("{:?}", data.mac_address());
            break;
        }
    }
    println!("CPU: {}", cpu);
    println!("Mem: {}", mem);
    println!("OS Ver: {}", os_ver);
    println!("IP: {}", ip);
    println!("MAC: {}", mac);
}
