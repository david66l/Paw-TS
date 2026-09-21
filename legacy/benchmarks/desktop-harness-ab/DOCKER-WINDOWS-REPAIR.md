# Windows Docker 启动故障记录

2026-09-08，本机诊断；不是模型 benchmark 结果。

## 已证实

- Docker Desktop 4.85.0 后端在初始化 `dockerInference` 时退出，Windows 返回 error 1920（The file cannot be accessed by the system）。Linux engine 尚未启动，因此 `docker info` 等待或报命名管道不存在；不能将此直接归因于 WSL 损坏。
- 多个残留 socket 位于 `%LOCALAPPDATA%/Docker/run/` 和 `%LOCALAPPDATA%/docker-secrets-engine/`。最早创建时间为 2026-09-07 18:43，本机最近启动时间为 21:43，说明文件跨重启遗留。
- 已从 Docker 官方下载并升级到 **4.89.0**，保留原来的 per-user 安装和 WSL 后端。安装程序退出码 0、Docker Inc 数字签名有效，SHA256 与官方校验值一致：`854626704af28a160d5af68b96b3e32eacf08ab397ce6c12eb02a04788d73681`。
- 新版会尝试把坏 socket 改名为 `.stale`，但本机仍返回 1920。停止 Docker 后，整体改名保留上述通信目录，并创建新目录，成功启动 Engine **29.7.2**。
- 无网络、只读根文件系统、128 MiB 内存的 `node:24-alpine` 容器输出 `DOCKER_SMOKE_OK`。原有五个服务容器可见，PostgreSQL 等数据卷仍在；旅行项目 backend 的应用级反复重启是另一现象。
- 通过 `docker desktop stop --timeout 45` 正常退出成功，但再次从自动化命令启动，仍在新生成的 `sailor-ingest.sock` 上失败。**因此升级与一次启动成功不等于问题已彻底解决。**

## 当前状态与下一项验证

再次隔离保留故障通信目录后，用户从 Windows 开始菜单启动成功、无报错。随后确认 Engine 29.7.2 正常；128 MiB、无网络、只读容器再次输出 `DOCKER_SMOKE_OK`；与重启前记录相比，容器 ID、镜像 ID、数据卷名称清单均无差异（16 个容器、25 个镜像）。未卸载 WSL、未恢复出厂、未删除镜像/容器/卷。

Docker 现已可用。后续保持用户正常桌面启动的实例运行，自动化只使用引擎，不再从本次自动化进程树启动 Desktop。现有对照支持启动路径与故障有关，但未定位底层具体机制；尚未验证系统再次重启后的长期稳定性。

相似公开报告称 AF_UNIX 生命周期可能受自动化进程启动环境影响，**这只是待验证的本机假设**，不能据此认定 Codex 或 Windows 的具体缺陷。一个计划中的独立 socket 生命周期诊断命令被自动审批检查以 `blocked by policy` 拒绝，未执行，也未绕过。

本地保留证据及安装包：`%TEMP%/paw-docker-repair-20260908/`；其中包含升级前设置备份，只供本机排障，不应上传或提交。Docker 通信目录备份均为相邻的 `*.stale-20260908-*` 目录，不包含容器数据盘。

正常桌面启动、受限容器执行和镜像/容器/卷清单一致性已验证，可以恢复真实模型 benchmark。正常桌面退出再启动及系统重启仍未验证；不要重复从已失败的自动化启动路径运行 Docker，也不要把清理残留当作永久修复。

## 来源

- [Docker 4.89.0 更新说明](https://docs.docker.com/desktop/release-notes/#4890)：包含异常退出后 stuck socket 启动故障修复。
- [Docker 官方安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)：per-user 更新参数。
- [Docker socket 启动故障报告](https://github.com/docker/desktop-feedback/issues/448)：关闭 Model Runner 时仍初始化 socket 的同类现象。
- [自动化进程 AF_UNIX 生命周期报告](https://github.com/anthropics/claude-code/issues/76383)：对照启动方式的调查线索，不是本机根因的证明。
