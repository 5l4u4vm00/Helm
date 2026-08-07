; Windows 檔案總管右鍵選單：「Open with Helm」。
; 由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 掛入 NSIS 安裝流程。
;
; 兩個註冊位置缺一不可，對應兩種右鍵操作：
;   Directory\shell             — 在某個資料夾「圖示」上按右鍵（%1 = 該資料夾）
;   Directory\Background\shell  — 在已開啟的資料夾「空白處」按右鍵（%V = 目前資料夾）
; 背景選單必須用 %V，用 %1 會拿到空字串。
;
; 一律寫 HKCU 而非 HKCR/HKLM：Tauri 的 NSIS 預設是 currentUser 安裝（不需要
; 系統管理員權限），此時 HKLM 寫入會失敗。HKCU 對安裝者本人生效即可。

!macro NSIS_HOOK_POSTINSTALL
  ; 資料夾圖示上的右鍵
  WriteRegStr HKCU "Software\Classes\Directory\shell\Helm" "" "Open with Helm"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Helm" "Icon" "$INSTDIR\Helm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Helm\command" "" '"$INSTDIR\Helm.exe" "%1"'

  ; 資料夾空白處的右鍵
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Helm" "" "Open with Helm"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Helm" "Icon" "$INSTDIR\Helm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Helm\command" "" '"$INSTDIR\Helm.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; DeleteRegKey 會連子機碼一起刪，command 不必另外處理。
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Helm"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Helm"
!macroend
