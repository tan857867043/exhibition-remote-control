use turbojpeg::{Compressor, Image, PixelFormat, Subsamp};
fn main() {
    let mut c = Compressor::new().unwrap();
    c.set_subsamp(Subsamp::Sub2x2);
}
