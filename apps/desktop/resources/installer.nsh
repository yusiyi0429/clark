; 卸载时删掉开机自启（壳用 setLoginItemSettings 写的 HKCU Run，名字见 src/main.ts 的 LOGIN_ITEM），免得留一条指向已删程序的自启。
; 升级时（electron-updater 静默重装）也会先跑卸载：删了没关系，新版启动时会重新登记。
; 开始菜单和桌面的「天枢」快捷方式也删：11/08 实测 electron-builder 自带的卸载没删掉中文名的快捷方式（升级时新版会重新建）。
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TianshuDesktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "TianshuDesktop"
  Delete "$SMPROGRAMS\天枢.lnk"
  Delete "$DESKTOP\天枢.lnk"
!macroend
