# Helm statusline forwarder: relay Claude Code's statusline JSON to Helm
# (cost / context usage), then print a compact status line.
#
# 與 helm-hook.ps1 分成兩支檔案（而非共用 -Source 參數）的原因：statusline 要寫
# stdout，而 hook 的 stdout 會被 Claude Code 當控制輸出解讀，混在一支腳本裡很
# 容易誤印。curl.exe 與 UTF-8 編碼的理由見 helm-hook.ps1。
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

# 先讀 stdin 再 POST：curl 失敗不能弄丟印狀態列要用的資料。
$json = [Console]::In.ReadToEnd()

try {
  $port = $env:HELM_EVENT_PORT
  if ($port) {
    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if ($curl -and $json) {
      $uri = "http://127.0.0.1:$port/hook?session=$($env:HELM_SESSION_ID)&source=claude-code-statusline"
      $json | & $curl -s -m 2 -X POST $uri --data-binary '@-' *> $null
    }
  }
} catch { }

# 輸出格式與 Unix 版一致："<model> $<cost> <left>% left"。用 ConvertFrom-Json
# 而非模仿 sed 的 regex 擷取——PowerShell 有真的 JSON parser。但官方 schema 中
# used_percentage / remaining_percentage / current_usage 都可能是 null，逐一判空。
$line = 'Claude'
try {
  $o = $json | ConvertFrom-Json
  if ($o.model.display_name) { $line = $o.model.display_name }
  if ($null -ne $o.cost.total_cost_usd) { $line += ' $' + $o.cost.total_cost_usd }
  $left = $o.context_window.remaining_percentage
  if ($null -eq $left -and $null -ne $o.context_window.used_percentage) {
    $left = 100 - $o.context_window.used_percentage
  }
  if ($null -ne $left) { $line += ' ' + $left + '% left' }
} catch { }

# Write-Host -NoNewline 對應 Unix 版的 printf '%s'（不加結尾換行）。
Write-Host -NoNewline $line
exit 0
