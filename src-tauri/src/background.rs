// 讀取使用者選的背景圖並回傳 data: URL。
// 原因：asset protocol（asset:// + convertFileSrc）在打包後的 macOS WKWebView 中
// 常因 scope glob 比對而載不出圖；改由 Rust 直接讀檔（不受 assetProtocol scope 限制，
// 外接磁碟等任意位置都可讀）轉成 base64 data: URL，CSP 的 img-src 已允許 data:。
use base64::{engine::general_purpose::STANDARD, Engine};

/// Read an image file and return it as a `data:<mime>;base64,...` URL.
/// Works for any readable path (external volumes included) — no asset-protocol scope involved.
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return Err(format!("unsupported image extension: {ext}")),
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
