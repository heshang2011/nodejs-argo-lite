# nodejs-argo-lite

精简版 Argo 隧道节点生成器，只保留 **VLESS(WebSocket) + Cloudflare Argo 隧道** 功能。

与完整版相比，去掉了哪吒探针、VMess / Trojan / Hysteria2 / Reality / Socks5、Telegram 推送、自动保活等模块，
并改用官方二进制来源（Xray-core、cloudflared）。

## 工作流程

1. 按平台自动下载 `Xray-core` 与 `cloudflared`
2. 生成 Xray 配置并启动 VLESS WebSocket 入站（本地 `ARGO_PORT`）
3. 启动 Argo 隧道：填写 `ARGO_DOMAIN` + `ARGO_AUTH` 用固定隧道，否则用临时隧道
4. 解析隧道域名，生成 `vless://` 节点与 base64 订阅
5. 通过内置 HTTP 服务输出订阅

隧道域名默认展示伪装页（一个正常的企业站点），访问者无法看出这是节点服务；
只有 `/<SUB_PATH>` 订阅路径和 VLESS 的 WebSocket 路径会返回真实内容。

可选集成 **VPS-DOG 探针**（[heshang2011/vps-dog](https://github.com/heshang2011/vps-dog)）：
填写 `NEZHA_SERVER` + `NEZHA_KEY` 后，进程内会同时拉起 vps-dog agent 上报主机指标。

## 环境变量

| 变量名 | 必须 | 默认值 | 说明 |
|--------|------|--------|------|
| `PORT` | 否 | `3000` | HTTP 订阅服务端口 |
| `UUID` | 否 | 内置 UUID | 节点 UUID |
| `ARGO_PORT` | 否 | `8001` | Xray 本地监听端口，需与隧道指向端口一致 |
| `ARGO_DOMAIN` | 否 | - | 固定隧道域名，留空使用临时隧道 |
| `ARGO_AUTH` | 否 | - | 固定隧道 token 或 JSON 凭证 |
| `CFIP` | 否 | `www.visa.com.tw` | 优选 IP / 域名 |
| `CFPORT` | 否 | `443` | 优选 IP 端口 |
| `NAME` | 否 | `argo-vless` | 节点名称 |
| `FILE_PATH` | 否 | `./tmp` | 运行目录（存放二进制、日志、订阅） |
| `SUB_PATH` | 否 | `sub` | 订阅路径 |
| `SHOW_LOG` | 否 | `false` | 日志总开关，默认静默；`true/yes/1/on` 恢复完整输出 |
| `XRAY_URL` | 否 | 官方 GitHub | 自定义 Xray 压缩包地址 |
| `CF_URL` | 否 | 官方 GitHub | 自定义 cloudflared 地址 |
| `DISGUISE` | 否 | `true` | 是否启用伪装页，`false/no/disable/0` 关闭 |
| `DISGUISE_FILE` | 否 | `./disguise.html` | 自定义伪装页文件路径 |
| `NEZHA_SERVER` | 否 | - | VPS-DOG 面板地址，如 `https://vps-dog.xxx.workers.dev` |
| `NEZHA_KEY` | 否 | - | 面板签发的 Agent 令牌（64 位 hex） |
| `NEZHA_NAME` | 否 | `NAME` / 主机名 | 节点显示名，仅首次上报生效 |
| `NEZHA_REGION` | 否 | - | 地区标签，如 `HK` |
| `NEZHA_INTERVAL` | 否 | `30` | 上报间隔秒，自动限制在 10..3600 |
| `NEZHA_TLS_SKIP_VERIFY` | 否 | `false` | 面板证书自签名时设为 `true` |
| `NEZHA_BIN` | 否 | 内置 `bin/` | 自定义探针二进制路径 |
| `AUTO_ACCESS` | 否 | `false` | 是否开启自动保活 |
| `PROJECT_URL` | 否 | - | 需要保活的项目地址，开启保活时必填 |
| `KEEPALIVE_INTERVAL` | 否 | `5` | 保活间隔分钟，最少 1 分钟 |
| `CLEAN_DELAY` | 否 | `90` | 启动后多少秒自删运行文件，`0` 关闭 |

## 使用

```bash
npm install
npm start
```

启动后访问：

- 伪装页：`http://localhost:3000/`（任意路径都返回伪装页）
- 订阅：`http://localhost:3000/sub`

## 静默运行（默认）

`SHOW_LOG` 默认为 `false`，平台上**不会出现任何输出**：

- Xray 的 access log 被显式关闭（`access/error: none`）。这一项最要紧 ——
  不关的话每访问一个网站都会打一行 `from <客户端IP> accepted tcp:<域名>:443`，
  等于把你的浏览记录和客户端 IP 公开在平台日志里。
- 节点链接、订阅路径、启动横幅、清理提示全部改为受控输出，只在 `SHOW_LOG=true` 时打印。
- cloudflared 的输出只写本地日志文件，不透传到平台日志；固定隧道额外降到 `warn`。
- 连 Node 自身的告警（DeprecationWarning）和未捕获堆栈也一并吞掉。

排障时临时设 `SHOW_LOG=true`，日志会完整输出，运行目录下也会保留 `xray.log`、
`cloudflared.log`、`vps-dog.log`。

> 临时隧道的域名必须从 cloudflared 的 `info` 日志里解析，因此临时隧道场景
> 日志级别不能降级；但输出只落在本地文件，90 秒后随其他运行文件一起删除。

## 伪装页

伪装页位于 `disguise.html`，默认是一个名为 Meridian 的数据基础设施产品站，包含
导航、Hero 数据面板、指标区、特性卡片、命令行演示、CTA 与页脚，响应式适配桌面和移动端。

工作方式：

- 隧道 / HTTP 入口的**所有普通请求**都返回伪装页，包括不存在的路径（返回 200 而非 404）
- 只有 `/<SUB_PATH>`（默认 `/sub`）返回订阅，VLESS 的 WebSocket 路径正常握手
- 订阅路径未设置时，节点信息只输出到运行日志，不落到伪装页上

想换成自己的站点，直接把 `disguise.html` 替换成任意 HTML 文件，或用 `DISGUISE_FILE` 指向其他文件即可。

## VPS-DOG 探针

探针与节点在同一个进程里托管，生命周期一致 —— 主进程退出时探针会被一并回收，不会留下孤儿进程。

1. 在 VPS-DOG 面板 `/admin/nodes` 添加节点，复制令牌（只显示一次）
2. 启动时带上 `NEZHA_SERVER` 与 `NEZHA_KEY`

```bash
NEZHA_SERVER=https://vps-dog.xxx.workers.dev \
NEZHA_KEY=<TOKEN> \
NEZHA_NAME=hk-01 \
NEZHA_REGION=HK \
npm start
```

探针二进制已随仓库提供（`bin/`），覆盖 linux amd64 / arm64 / armv7 与 windows amd64，
因此部署时无需访问 GitHub。查找顺序为 `NEZHA_BIN` → 内置 `bin/` → GitHub Release。

探针失败只记录日志，不影响节点生成与订阅。日志见运行目录下的 `vps-dog.log`。

## 自动保活

免费 PaaS（Render、Koyeb 等）会把长时间无请求的实例休眠或回收。开启保活后，
进程内会定时访问 `PROJECT_URL`，让它一直有流量。

```bash
AUTO_ACCESS=true \
PROJECT_URL=https://your-app.onrender.com \
KEEPALIVE_INTERVAL=5 \
npm start
```

行为说明：

- 启动时立即访问一次（可顺带唤醒已休眠的实例），之后每 `KEEPALIVE_INTERVAL` 分钟一次
- 纯进程内实现，**不向任何第三方服务上报你的域名**（原版的 `oooo.serv00.net` 已移除）
- 请求超时 15 秒，连续失败 3 次以上才打印错误，避免偶发抖动刷屏
- `PROJECT_URL` 必须是 `http://` 或 `https://` 开头，否则只警告并跳过
- 未开启 `AUTO_ACCESS` 或未填 `PROJECT_URL` 时静默跳过，不影响节点功能

## 文件自删

节点启动成功后会延时删除运行目录下的落地文件，避免配置、令牌、日志留在磁盘上：

```
删除：config.json、tunnel.json、tunnel.yml、agent.yaml、
      xray.log、cloudflared.log、vps-dog.log、下载的二进制
保留：sub.txt（订阅兜底）
```

设计要点：

- **显式清单**，不遍历目录 —— `FILE_PATH` 指向共享目录时不会误删无关文件
- 删除前先关闭日志写入流，否则 Windows 上文件被占用删不掉
- 二进制在 Linux 上能删掉（运行中的进程持有 inode，不受影响）；
  Windows 会因文件占用保留，属正常现象
- 进程已在内存中运行，删除配置文件不影响节点、伪装页、探针与保活
- 延时由 `CLEAN_DELAY` 控制，设为 `0` 可完全关闭

固定隧道示例（Cloudflare Tunnel token）：

```bash
ARGO_DOMAIN=argo.example.com \
ARGO_AUTH=eyJhIjoi... \
NAME=my-node \
npm start
```

## Docker

```bash
docker build -t nodejs-argo-lite .
docker run -d --name argo-lite -p 3000:3000 -e UUID=your-uuid nodejs-argo-lite
```

### 自动构建

仓库自带 `.github/workflows/docker.yml`，推送到 `main` / `master` 时会自动构建并推送
多架构镜像到 GitHub Container Registry：

```bash
docker pull ghcr.io/<你的用户名>/<仓库名>:latest
```

构建架构：`linux/amd64`、`linux/arm64`、`linux/arm/v7`。

镜像里的探针二进制按目标架构裁剪 —— `amd64` 只留 `vps-dog-linux-amd64`，
`arm64` 只留 `vps-dog-linux-arm64`，`arm/v7` 只留 `vps-dog-linux-armv7`，
Windows 版一律剔除，因此每个架构的镜像都能正常安装并启动探针。

> 基础镜像固定为 `node:22-alpine`：`node:alpine`、`node:lts-alpine`、`node:24-alpine`
> 都已不再发布 `linux/arm/v7`，用它们会导致 arm/v7 构建失败。
>
> `linux/arm/v6` 不受支持：Xray 与 cloudflared 都没有可用的 armv6 构建，
> 构建时会显式报错退出，而不是产出一个装不了探针的镜像。

## 说明

- 仅支持本机 Linux / Windows / macOS 运行，`FILE_PATH` 需可写。
- 临时隧道每次重启域名都会变化，长期使用建议配置固定隧道。
- 请遵守当地法律法规，仅用于个人学习与合法用途。
