; NSIS installer hooks for Coso.
; Tauri runs this file at bundle time; the hook macros below are injected into
; the generated installer so the app gets a visible desktop shortcut after
; setup, matching the Start-menu entry.

!macro NSIS_HOOK_POSTINSTALL
  ; Explicit target, icon and description: a bare CreateShortcut call can
  ; leave the shortcut resolving oddly on some machines (blank window).
  CreateShortcut "$DESKTOP\Coso.lnk" "$INSTDIR\coso.exe" "" "$INSTDIR\coso.exe" 0 SW_SHOWNORMAL "" "" "Coso"
!macroend
