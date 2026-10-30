fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/favicon.ico");
        // 版本信息
        res.set("FileDescription", "展厅远程控制 Agent");
        res.set("ProductName", "展厅远程控制");
        res.set("ProductVersion", "0.1.0");
        res.set("FileVersion", "0.1.0");
        res.set("OriginalFilename", "exhibition-agent.exe");
        res.set("LegalCopyright", "Exhibition Remote Control");
        if let Err(e) = res.compile() {
            eprintln!("winres compile error: {}", e);
            std::process::exit(1);
        }
    }
}
