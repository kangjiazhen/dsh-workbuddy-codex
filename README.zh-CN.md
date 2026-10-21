# dsh-workbuddy-stack

**中文** | [English](README.md)

一个 DeepSeek Harness 插件，用来把本机的 WorkBuddy 反代链路「看活」。

要用上 WorkBuddy 的模型，必须有两个服务在跑，而它们都不会把自己装成 Windows 服务：

| 端口 | 服务 | 作用 |
| --- | --- | --- |
| `127.0.0.1:7863` | `wb2api` 网关 | OpenAI 兼容的 `/v1/chat/completions` |
| `127.0.0.1:7864` | `codex-chat-bridge` | Responses API → chat/completions，供 Codex CLI 使用 |

以前这两个都得手动起，于是重启一次之后，模型选择器还指着一个死掉的端口——provider 插件加载正常、模型列表也正常，第一条请求才失败。这个插件负责看住它们：加载时探测各自的健康端点，缺哪个就拉哪个，之后按定时器复查，进程崩了会被重新拉起。

它**刻意不重新实现网关**，只编排磁盘上已经存在的进程。provider 注册仍然交给 provider 插件（`dsh-llm-workbuddy` 之类）——这个插件唯一的工作，是保证那个 provider 要连的端口真的在应答。

## 安装

```bash
dsh plugin add git+https://github.com/kangjiazhen/dsh-workbuddy-stack.git
```

或者从本地目录装：

```bash
dsh plugin add file:/path/to/dsh-workbuddy-stack
```

插件自带 `cordis.patch.yml`，所以只要包进了 profile 依赖，profile 就会自动带上 `workbuddy-stack` 这一项。

### 如果 git 安装失败

`pnpm` 会把 `git+https://…` 改写成 `git+ssh://git@…`，所以在没有配 GitHub SSH 密钥的机器上会报 `Permission denied (publickey)`：

```bash
npm config set git-protocol https
```

走代理时还要单独告诉 git——`pnpm` 是去调 `git` 二进制的，不会把自身的代理设置传下去：

```bash
git config --global http.proxy http://127.0.0.1:7890
```

## 配置

默认值假定用家目录下的常规布局，可以在 profile 的 `cordis.yml` 里覆盖：

```yaml
- id: workbuddy-stack
  name: dsh-workbuddy-stack
  config:
    intervalMs: 15000        # 复查间隔
    probeTimeoutMs: 2000     # 单次探测超时

    gateway:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7863
      acceptStatus: [200, 503]
      command: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel/wb2api.exe
      args: [-config, config.json]
      cwd: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    bridge:
      enabled: false
      autostart: true
      baseURL: http://127.0.0.1:7864
      acceptStatus: [200]
      command: node
      args:
        - ~/Documents/deepseek-harness/default-workspace/codex-chat-bridge/bin/codex-chat-bridge.mjs
        - --port
        - '7864'
        - --upstream
        - http://127.0.0.1:7863
```

路径支持 `~`、`$VAR` / `${VAR}` 和 Windows 的 `%VAR%`，所以配置文件可以在不同机器之间直接拷，不用重写家目录。

`bridge.enabled` 默认是 `false`：这一半链路只服务 Codex CLI，在没装 `codex-chat-bridge` 的机器上就该保持安静。

### `acceptStatus` 为什么重要

网关在**还活着但上游账号不可用**的时候（没登录、或者所有账号都在冷却），`/healthz` 返回的是 **`503`**。这是「活着」，不是「挂了」。

只认 `2xx` 的守护逻辑会把它当成「没启动」，于是再起一份，然后两份抢同一个端口。所以网关这一项默认接受 `[200, 503]`，而桥只接受 `[200]`。

### `autostart: false`

只看不管：探测、上报，但永不 spawn。适用于生命周期归别的东西管的场景——计划任务、容器、包装脚本——你只想要健康状态。

## 状态工具

当 `tools` 这条缝挂载着的时候，插件会注册 `workbuddy_stack_status`：

```
gateway: up (http://127.0.0.1:7863/healthz, pid 14592)
bridge: up (http://127.0.0.1:7864/healthz)
```

每行都带实时探测结果、受管子进程 pid，以及上次拉起失败的错误——这样「模型列表是空的」和「端口是死的」不用翻日志就能分清。

如果 `@deepseek-ai/dsh-tools` 导入不到，工具仍然会用原始描述符注册；如果 `tools` 这条缝根本不在，守护逻辑照样跑。两者互不依赖。

## 生命周期

- 第一次检查在 `apply()` 之后异步跑，冷启动不会卡住 harness。
- 定时器带 `unref()`，空转的守护不会把宿主进程吊着不放。
- dispose 时停掉定时器，并终止**由本插件拉起的**子进程。插件加载前就已经在跑的服务只探测、只上报、绝不收养，所以卸载插件不会杀掉别人起的进程。

## 范围与限制

- 只做进程守护。它不启动、不停止、不配置**上游** provider，也不对哪些模型可用有任何意见。
- 没有重启退避：秒崩的子进程会按 `intervalMs` 一次一次被拉起。如果二进制不存在、或者端口被别的进程占着，日志每一轮都会直说，而不是空转。
- spawn 时带 `windowsHide: true`，Windows 下受管的控制台子进程不会闪窗。
- Linux / macOS 用同一份代码即可，只有 `cordis.patch.yml` 里的默认路径是 Windows 专用。

## 相关项目

- [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge) —— 本插件可以守护的那个 Responses → chat/completions 桥。
- [LiteLLM](https://github.com/BerriAI/litellm)、[one-api](https://github.com/songquanpeng/one-api)、[new-api](https://github.com/Calcium-Ion/new-api) —— 如果你要的是路由和密钥管理而不是本机进程守护，用这些完整的网关。

## 许可证

MIT
