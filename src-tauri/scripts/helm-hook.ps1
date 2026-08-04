# Helm hook forwarder: relay Claude Code's hook stdin JSON to Helm.
#
# Windows 上 Claude Code 用 Git Bash（沒裝才 PowerShell）執行 settings.json 的
# command 字串，因此指令寫成「powershell -File <本檔>」——「執行檔 + 參數」的
# 形式在兩種 host 下解析一致，不必偵測 host。
#
# 用 curl.exe 而非 Invoke-RestMethod：後者對 string body 在沒給 -ContentType 時
# 會送成 form-urlencoded 並把 JSON URL-encode，且 5.1/7.x 的字串編碼與 BOM 行為
# 不一致——一個 BOM 就會讓 hookserver.rs 的 serde_json::from_str 失敗，而那條路徑
# 永遠回 200 並靜默丟棄事件，完全無法診斷。curl --data-binary @- 則與 Unix 版
# 語義逐行對應：原始 bytes、無編碼轉換、無 BOM。
# 注意必須寫 curl.exe：裸 curl 在 PowerShell 5.1 是 Invoke-WebRequest 的別名。
$ErrorActionPreference = 'SilentlyContinue'

# PowerShell 5.1 的 $OutputEncoding 預設是 ASCII，pipe 給原生 exe 時會把非 ASCII
# 轉成 '?'——CJK 檔案路徑或中文 prompt 會被打爛且無聲失敗。必須設成無 BOM UTF-8。
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

try {
  $port = $env:HELM_EVENT_PORT
  if ($port) {
    # $input 只在 PowerShell pipeline 內才有值；-File 啟動的腳本要讀真實 stdin。
    $json = [Console]::In.ReadToEnd()
    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if ($curl -and $json) {
      $uri = "http://127.0.0.1:$port/hook?session=$($env:HELM_SESSION_ID)&source=claude-code"
      # '@-' 單引號：否則 PowerShell 會把 @- 當 splat token 解析。
      # *> $null 導掉所有 stream——hook 的 stdout 會被 Claude Code 當控制輸出解讀。
      $json | & $curl -s -m 2 -X POST $uri --data-binary '@-' *> $null
    }
  }
} catch { }

# 無條件成功（等價於 Unix 版的 "; exit 0"）：Helm 沒開或 hook server 沒起來時，
# 絕不能讓 Claude Code 對使用者顯示 hook 失敗。
exit 0
