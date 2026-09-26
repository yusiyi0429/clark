# 04b 隔离浏览器控制

当前实例：API 4500 / PID `26976`，数据库 `warmap_test_fbbf518b5f07`，临时人员目录 `C:\Users\10021\AppData\Local\Temp\warmap-04b-browser-mn4JXb`。目录是唯一的 `warmap-04b-browser-*`，创建于 2026-09-27 06:29:58，API 进程启动于 06:29:54。目录匹配依据是此前缀与时间；控制脚本不读任何真实人员或凭据。

在仓库根目录执行：

```powershell
& .\apps\api\node_modules\.bin\tsx.cmd .scratch/onboarding/evidence/04b/browser-control.ts inspect
& .\apps\api\node_modules\.bin\tsx.cmd .scratch/onboarding/evidence/04b/browser-control.ts close-round
```

`inspect` 只读：分别输出全部 Mission 数量和挂卡 Mission 数量，避免混入测试库可能已有的非挂卡资料；输出卡 ID、意见类型／版本／引用摘要及快照条数。`close-round` 调用产品的 `closeDueRounds`，以开放轮次最晚截止时刻为本次快照时钟；它不能修改已经运行的 API 进程的固定应用时钟，后续留言时间不能作为截止边界演练证据。

验收结束、负责人停止本次 API 后，才可执行：

```powershell
& .\apps\api\node_modules\.bin\tsx.cmd .scratch/onboarding/evidence/04b/browser-control.ts clean
```

`clean` 不会停止进程；PID、4500 端口或数据库连接仍活跃时拒绝清理。只能删除上面这个固定测试库及固定人员目录，不接收其他数据库或路径参数。清理人员目录时只删除 `people.json`，然后删除空目录，不做递归删除。

临时 Web 副本存在时直接调用已安装的 `tsx.cmd`。不要用 `pnpm exec` 启动控制脚本：工作区自动依赖检查可能试图同步临时 importer；本次尝试已在缺少副本 vendor 包处停止，未进入数据库。

下次启动 `browser-server.ts` 时，`exec_command` 应设 `tty: true`，保留交互 stdin。随后用 `write_stdin` 发送 `inspect\n`、`close-round\n`、`close\n`；其中进程内部的 `close-round` 会同时推进注入的应用时钟，是完整截止后演练的首选。不要在命令参数或日志里打印会话 cookie 或读取 `.env`。
