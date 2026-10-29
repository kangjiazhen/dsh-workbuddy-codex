# workbuddy2everything

[English](README.md) | **简体中文**

> **仓库已改名为 `workbuddy2everything`，npm 包名仍是 `dsh-workbuddy-codex`。** 旧地址有 301 跳转，已经 clone 的仓库和 `github:` 依赖都照常工作，不需要重装。

一个 DeepSeek Harness 插件，把本地 WorkBuddy 网关变成**任何客户端都能用的模型后端** —— 模型选择器的 provider、它背后的网关，**以及两条内置协议桥：给 OpenAI Codex CLI 的 Responses，给 Claude Code / Claude 桌面端的 Anthropic Messages**。

在 WorkBuddy 模型能回答之前，有这些环节必须同时对上，而它们都不会把自己装成 Windows 服务：

| 端口 | 服务 | 作用 |
| --- | --- | --- |
| `127.0.0.1:7863` | `wb2api` 网关 | OpenAI 兼容的 `/v1/chat/completions` |
| `127.0.0.1:7864` | Responses 桥（**内置**） | Responses API → chat/completions，供 Codex CLI 使用 |
| `127.0.0.1:7865` | Anthropic Messages 桥（**内置**） | Anthropic `/v1/messages` → chat/completions，供 Claude Code / Claude 桌面端 3p 使用 |
| — | `workbuddy` provider | 模型选择器里的那条路由，**从 [`dsh-llm-workbuddy`](https://www.npmjs.com/package/dsh-llm-workbuddy) 挂载而来** |

这些进程过去都要手动启动，于是重启一次电脑之后，模型选择器会悄无声息地指向一个死掉的端口 —— provider 插件加载正常、模型列表正常，直到第一次请求才失败。本插件接管它们：加载时探测各自的健康端点，缺什么就拉起什么，并按定时器复查，进程崩了会自动回来。

它刻意**既不重写网关，也不 fork 适配器**。网关只做进程编排；provider 路由则是用 `ctx.plugin()` 委派给 `dsh-llm-workbuddy` 挂载出来的 —— 那个包自己拥有约 2500 行的 WorkBuddy 适配器、设置面板和每日签到调度器，再抄一份只会让两边一更新就分叉。所以装一次就同时得到 provider + 网关 + 桥。

这种委派是叠加式的，不是排他的：如果你同时保留独立的 `dsh-llm-workbuddy`，谁先注册这条路由谁就拥有它，另一个会在日志里说明后退让，两种装法都安全。

## 配置项

全部位于 profile 的 `cordis.yml` 中 `workbuddy-codex` 条目的 `config` 下；随包发布的 `cordis.patch.yml` 里是完整的默认值。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `gatewayDir` | `~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel` | 网关存放 `config.json` 的目录。其中的 `api_key` 会同时用于**桥和 provider**，所以端口与密钥只需配一次。 |
| `provider.enabled` | `true` | 是否注册 `workbuddy` 路由。 |
| `provider.baseURL` | *(留空 → 用 `gateway.baseURL`)* | 适配器要访问的网关地址。 |
| `provider.discovery` | `true` | 向网关的 `/v1/models` 拉取实时模型目录。 |
| `provider.autoCheckin` | `true` | 领取 WorkBuddy 每日签到。 |
| `gateway.acceptStatus` | `[200, 503]` | 网关在无可用账号时仍会跑着并返回 `503`，那是活着，不是挂了。 |
| `bridge.conversationId` | `auto` | 对着 WorkBuddy 网关不是可选项：缺了它上游会回 `400 / 11-128`，网关随即停用该账号。 |
| `bridge.maxPromptTokens` | `1200000` | 估算提示词超过它就由桥在本地回 `413`，不把一个注定被上游以 `400 prompt_too_long` 拒绝的请求转发出去。`0` 关闭。见[为什么要在本地设上限](#为什么要在本地设上限)。 |
| `anthropicBridge.enabled` | `true` | 是否监护 Anthropic Messages 桥。 |
| `anthropicBridge.baseURL` | `http://127.0.0.1:7865` | 桥监听地址，也就是 Claude 那边要填的 gateway base URL。 |
| `anthropicBridge.upstream` | *(留空 → 用 `gateway.baseURL`)* | 桥转发的上游。留空即复用同一条网关。 |
| `anthropicBridge.apiKey` | *(留空 → 读网关注入的 `api_key`)* | 上游 bearer。留空时与 Responses 桥共用同一份密钥，不会有两份会漂移的秘密。 |
| `anthropicBridge.defaultModel` | *(留空 → 目录第一条)* | 只在客户端直接点名一个裸 Claude 别名（`claude-sonnet-5-5`、`opus`）时才用得上。见[Claude 侧怎么接](#claude-侧怎么接)。 |

如果根本没装 `dsh-llm-workbuddy`，插件照旧监护网关与桥，并打印出补装它的那一条命令（`dsh plugin add dsh-llm-workbuddy`）。任何情况下都不会抛错。

## 为什么桥是内置的

`codex-cli` 0.1xx 之后删掉了 `wire_api = "chat"`，只讲 OpenAI 的 **Responses** 协议（`POST /v1/responses`，SSE）。而 WorkBuddy 网关只实现 **Chat Completions**（`POST /v1/chat/completions`）。让 Codex 直连网关，每个请求都会死在这里：

```
unexpected status 404 Not Found, url: http://127.0.0.1:7863/v1/responses
```

这不是配置项能绕过的问题 —— Codex 在加载阶段就直接拒绝 `wire_api = "chat"`。转换层是必需品，所以本包自带一个：

```
Codex CLI --(Responses)--> 桥 :7864 --(ChatCompletions)--> 网关 :7863 --> WorkBuddy
```

它和 [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge) 是同一份代码，以 `bridge/codex-chat-bridge.mjs` 内置（零依赖，跑在 Harness 自带的 Node 上），所以装这一个插件就够了 —— 不需要再 clone 第二个仓库，也没有任何路径要你填。

## 安装

```bash
dsh plugin add git+https://github.com/kangjiazhen/workbuddy2everything.git
```

或者从本地检出安装：

```bash
dsh plugin add file:/path/to/workbuddy2everything
```

插件自带 `cordis.patch.yml`，所以只要它成为 profile 依赖，profile 就会自动拿到 `workbuddy-codex` 这一条。

### 从 dsh-llm-workbuddy 迁移

本包已经覆盖了它原本的功能，所以如果 profile 里原本启用了它，需要改一处：把 profile 的 `package.json` 中 `dsh.profile.bundles` 里的那一行删掉，依赖保留。

```jsonc
"dsh": { "profile": { "bundles": [
  // "dsh-llm-workbuddy",   <- 删掉这一行
  "dsh-workbuddy-codex"
] } }
```

包本身必须留着 —— 本插件要 import 它来挂载 provider，而且适配器只有这一份，不存在第二份会分叉的代码。两个都留在 `bundles` 里也不会有害：先注册的那个拥有路由，另一个在日志里记一句 `already-served`；但那样服务你模型的是它而不是本插件，本插件「一次装好」的意义也就没了。

### git 安装失败的话

除非另有指定，`pnpm` 会把 `git+https://…` 改写成 `git+ssh://git@…`，因此在没有配置 GitHub SSH 密钥的机器上，安装会失败并报 `Permission denied (publickey)`：

```bash
npm config set git-protocol https
```

如果走代理，还得单独告诉 git —— `pnpm` 是通过调用 git 二进制实现的，不会把自己的代理设置传下去：

```bash
git config --global http.proxy http://127.0.0.1:7890
```

## 配合 Codex 使用

桥监听 `7864`，对外提供 Responses API。把 Codex 指过去：

```toml
# ~/.codex/config.toml
model = "global:gpt-5.3-codex"
model_provider = "wb"

[model_providers.wb]
name = "workbuddy"
base_url = "http://127.0.0.1:7864/v1"
wire_api = "responses"
experimental_bearer_token = "anything"
request_max_retries = 2
stream_max_retries = 2
```

桥本身不校验这个 bearer —— 它用自己的方式（从网关 `config.json` 读出的 key）向上游认证。填任意非空字符串即可，因为 Codex 没有它就不启动。

之后正常用 Codex 就行：

```bash
codex exec "列出当前目录的文件"
```

如果选到了你的账号档位用不了的模型，网关会返回 `11158 model not allowed for user type [...]`。那是账号属性，不是桥的故障 —— 见[模型可用性](#模型可用性)。

### 两个绝对不能跳过的设置

**1. `conversation_id` —— 能把账号搞封的那个。**

WorkBuddy 上游会校验三个头（`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`），缺任意一个就返回 `400 {"code":"11-128","msg":"request illegal"}`。网关把这种情况归类为*账号故障*，处理方式是**禁用账号** —— 而且是一轮里把碰到的账号全部禁用。它给出的原因是 `re-login required`，这句话有误导性：凭证通常仍然有效，解冻就能立刻恢复服务。

所以桥默认 `conversationId: auto`：按 Codex 会话（取自 `prompt_cache_key`）推导出一个稳定 id，作为 `metadata.conversation_id` 发送。不要把它置空，插件会在启动时告警。

如果不幸已经踩了，解冻账号即可，不需要重新登录：

```bash
# 网关面板：http://127.0.0.1:7863/panel/
curl -X POST http://127.0.0.1:7863/panel/api/accounts/<uid>/revive
```

**2. bearer 必须和网关的 `api_key` 一致。**

没有它，网关对每个请求都回 `401`。为了不让你手工抄密钥，插件直接从网关的 `config.json` 里读 `api_key`（`gatewayDir` 就是干这个的）并交给桥。只有要覆盖时才设 `bridge.apiKey`。

### 图片能不能进去，取决于模型目录

Codex 在**拼请求之前**会先读 `~/.codex/models.json`。如果所选模型的条目里 `input_modalities` 没有 `image`，Codex 自己就会把附件替换成一句 `image content omitted because you do not support image input` —— 桥根本收不到图，模型只能去读文件或者瞎猜。

所以凡是网关报 `supports_images: true` 的模型，条目里必须写上：

```json
{
  "slug": "cn:deepseek-v4.1-flash",
  "input_modalities": ["text", "image"]
}
```

桥对 `input_image` 是原样透传的（转成 `{"type":"image_url","image_url":{"url":"data:..."}}`），所以 Codex 侧图被吞掉，唯一原因就是目录条目不认图。以 `GET /v1/models` 返回的 `supports_images` 为准。

### 推理档位在两种协议里是两个字段

同一件事，两边名字不同，而且只有名字不同：

| 一侧 | 档位放在哪 |
| --- | --- |
| Responses（Codex） | `"reasoning": { "effort": "max" }` |
| Chat Completions（网关） | `"reasoning_effort": "max"` |

桥读 `reasoning.effort`，转发成扁平的 `reasoning_effort`；客户端没指定档位时不写这个字段，让上游默认值生效。少了这层映射，所有请求都会按网关默认档跑，`low` 和 `max` 行为完全一样 —— 选择器动了，模型没多想一步。

档位有哪些由网关说了算，不由桥决定。`GET /v1/models` 里的 `reasoning_supported_efforts` 才是权威：本网关 55 个模型里 17 个支持 `max`，其余按各自声明的子集走（有的只有 `medium`，有的 `low`/`high`，有的 `high`/`xhigh`）。模型没声明的档位会被网关静默丢弃。先选模型，再选档位。

## Claude 侧怎么接

Claude Code 和 Claude 桌面端（3p 模式）说的是 Anthropic Messages 协议（`POST /v1/messages`，SSE），网关只说 Chat Completions。第二条内置桥把前者翻成后者，监听 `7865`。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:7865
export ANTHROPIC_API_KEY=anything      # 桥不校验；它用网关的 key 向上游认证
claude
```

### Claude 桌面端（3p）

改它自己那份生效配置（每个安装的 UUID 不同，`_meta.json` 里的 `appliedId` 指向当前生效的那份）：

```jsonc
// %LOCALAPPDATA%\Claude-3p\configLibrary\<appliedId>.json
{
  "inferenceGatewayBaseUrl": "http://127.0.0.1:7865",
  "inferenceGatewayApiKey": "anything",
  "modelDiscoveryEnabled": true,
  "inferenceProvider": "gateway",
  "inferenceCredentialKind": "static",
  "defaultModelEffort": "max"   // 可选，见下节；改成 low/medium/high/xhigh 也行
}
```

三个要点：

- **不要写 `inferenceModels`。** 桌面端的 `inferenceModels` 是「手写死」的清单，一旦非空就会绕过 `/v1/models` 发现，下拉框只剩你抄进去的那几条。留空并打开 `modelDiscoveryEnabled`，下拉框才是网关目录的实时投影。
- **`inferenceGatewayBaseUrl` 允许 `http://` 回环地址**，其他主机名必须是 https。
- **`defaultModelEffort` 只影响桌面端「推荐」标记**，真正发给上游的档位由桥决定（见下节）。所以两处都不留白，行为才可预期。

### 上下文窗口与思考档位

网关目录里每个模型都有 `context_length`，本网关多数是 `1000000`。桌面端**不会**自己猜这个数：它读 `/v1/models` 每行的 `max_input_tokens`，缺失就套用自己的默认值 `200000`。桥不把这个字段透出去，下拉框里的模型就一律显示 200K，跟网关无关。

桥因此每行都带上：

| 发现行字段 | 来源 | 桌面端拿它做什么 |
| --- | --- | --- |
| `max_input_tokens` | 网关 `context_length` / `max_allowed_size` | 显示的上下文窗口；`>= 1000000` 时认作「1M 模型」 |
| `prefer_1m` | 同上 `>= 1000000` 时置 `true` | 自动选中 1M 变体，而不是让用户手点 |
| `max_output_tokens` | 网关 `max_output_tokens` | 单轮输出上限 |
| `max_effort_level` | 网关 `reasoning_supported_efforts` 的最高档 | 思考档位选择器的上限 |
| `behaves_as` | 桥固定填 `claude-sonnet-5`（仅推理模型） | 套用 Claude 家族的思考 UI，否则**没有档位选择器** |

`behaves_as` 是最容易漏的一条：桌面端只给它认识的 Claude 家族（`claude-<tier>-<version>`）渲染思考档位菜单。合成 id 里没有家族信息，所以桥单独声明一个。同时**下发档位不依赖客户端**：客户端没写 `output_config.effort` 时（桌面端在你动过选择器之前就是不发），桥取该模型支持的最高档。想要「默认最努力」，桥这一层是唯一可靠的地方。

### 为什么模型 id 要改写成 `claude-wb-…`

桌面端对发现回来的每一行都跑一个过滤器（`No()`）：id 里带别家品牌字样的（`kimi`、`gpt`、`deepseek`、`qwen`、`glm`…）直接丢弃，而且它还要 id 长得像 Anthropic 的路由（`claude…`）。真实的 `cn:kimi-k3.1-pro` 两条都过不了 —— 下拉框会空。

所以桥把真实 id 哈希成 `claude-wb-<10 hex>` 再发出去，真实 id 只存在于桥的内存目录里，而**人能读的名字走 `display_name`**（`CN · Kimi-K3.1-Pro`）。桥收到 `claude-wb-…` 再翻回真实 id 转发给网关。

还有一个坑：桌面端会按 `(name, Anthropic 家族)` 合并下拉框行。网关有几组不同的模型共用同一个显示名（`cn:hy3` / `cn:hy3-x`，`cn:hy4-preview` / `cn:hy4-preview-f` 等），直接照抄就会**静默少几条**。桥因此只在名字撞车时给标签补上 id 尾部做区分：`CN · Hy3 (x)`、`Global · Auto (chat)`。本网关实测 52 个模型 → 下拉框 52 条。

### 客户端直接点名裸 Claude 别名时

如果你写的配置里模型名是 `claude-sonnet-5-5` 这种裸别名（它没经过下拉框，所以桥不认识），桥不会 404，而是回落到 `anthropicBridge.defaultModel`，该值留空则用目录第一条。这样一个「从别处抄来的配置」也能出字，而不是让用户对着一条 404 猜。

## 配置

默认值假设了常规目录结构，可在 profile 的 `cordis.yml` 中覆盖：

```yaml
- id: workbuddy-codex
  name: dsh-workbuddy-codex
  config:
    intervalMs: 15000        # 复查间隔
    probeTimeoutMs: 2000     # 单次探测超时
    gatewayDir: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    gateway:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7863
      acceptStatus: [200, 503]
      command: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel/wb2api.exe
      args: [-config, config.json]
      cwd: ~/Documents/deepseek-harness/default-workspace/workbuddy2api-panel

    bridge:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7864
      acceptStatus: [200]
      command: ''            # 留空 = 运行内置桥
      upstream: ''           # 留空 = 用网关的 baseURL
      apiKey: ''             # 留空 = 读 gatewayDir/config.json
      conversationId: auto   # 必填 —— 见上文
      modelAllowlist: []     # 留空 = 放行所有模型

    anthropicBridge:
      enabled: true
      autostart: true
      baseURL: http://127.0.0.1:7865
      acceptStatus: [200]
      command: ''            # 留空 = 运行内置桥
      upstream: ''           # 留空 = 用网关的 baseURL
      apiKey: ''             # 留空 = 读 gatewayDir/config.json
      defaultModel: ''       # 留空 = 目录第一条
```

路径支持 `~`、`$VAR` / `${VAR}` 以及 Windows 的 `%VAR%`，所以同一份配置可以在机器之间直接拷。

`bridge.command` 留空是刻意的。一旦填了，插件就从「运行内置桥」切换成「监管这条命令」，用于指向另一个桥构建；`CCB_PORT`、`CCB_UPSTREAM` 等环境变量依然由插件推导。

### `acceptStatus` 很关键

网关在**进程活着但上游账号暂时不可用**时（没登录，或所有账号都在冷却），`/healthz` 返回 **`503`**。那是*活着*，不是*挂了*。

只认 `2xx` 的监管器会把它读成「没启动」，于是拉起第二份、抢端口失败。所以网关那条默认接受 `[200, 503]`，而桥只接受 `[200]`。

### `autostart: false`

只观察、永不拉起。当生命周期由别的东西掌管时用这个 —— 计划任务、容器、包装脚本 —— 你只想拿到健康状态上报。

## 状态工具

当 `tools` 缝挂载后，插件会注册 `workbuddy_codex_status`：

```
gateway: up (http://127.0.0.1:7863/healthz, pid 14592)
bridge: up (http://127.0.0.1:7864/healthz)
anthropicBridge: up (http://127.0.0.1:7865/healthz, pid 14593)
```

每行都带实时探测结果、被监管子进程的 pid，以及最近一次拉起失败的错误 —— 这样「模型列表是空的」和「端口死了」不用翻日志也能分清。

如果 `@deepseek-ai/dsh-tools` 无法导入，工具会记一条警告然后跳过，而不是用原始描述符硬塞：`tools.register()` 只接受 `defineTool` 造出来的形状（必须带 `output { schema, render }`），塞原始描述符会被静默拒绝，模型永远看不到这个工具。监管与 provider 不受影响 —— 它们都不依赖这个工具。

## 生命周期

- 第一次监管在 `apply()` 之后异步立刻执行，冷启动不会阻塞 Harness。
- 定时器是 `unref` 过的 —— 空转的监管器不会把进程吊住。
- dispose 时停掉定时器，并终止**本插件自己拉起**的子进程。加载插件之前就在跑的服务只探测上报、绝不接管，所以卸载插件不会杀掉别人启动的进程。

## 模型可用性

哪些模型能应答，取决于你的 **WorkBuddy 账号档位**，与本插件和桥无关。一个 `personal_free_user` 账号在 2026-10-21 实测能触达：

| 域 | 可用 |
| --- | --- |
| `global:` | `gpt-5.3-codex`、`glm-5.3`、`glm-5.2`、`kimi-k3`、`kimi-k2.6`、`hy4-preview`、`step-5-preview`、`deepseek-v4.1-flash`、`minimax-m3.1-flash` |
| `cn:` | `deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3` |

其余 GPT 模型（`gpt-5.4`、`gpt-5.5`、`gpt-6-*` 全系……）一律返回 `11158 model not allowed for user type [personal_free_user]`。这份名单随你的订阅变动，请当作快照而非承诺。

`modelAllowlist` 的用途是让已知不可达的模型**快速失败**：桥直接本地回 `400 model_not_allowed`，而不是让网关把拒绝归类成账号故障、进而禁用整个池子。留空是诚实的默认。

## 为什么要在本地设上限

上游的 `400 prompt_too_long` 不只是拒绝 —— 它**不返回 `usage`**。靠 `usage` 得知自己大小的客户端因此看不到超了多少，只能拿最后一次成功的数字反复重发同一份历史，永远到不了触发自动压缩的阈值。实测一个真实会话：最后一次成功是 `662,937` 输入 token，被拒的请求体是 `1,049,429`，而客户端计数器整个会话冻结在 `662,937`（950k 窗口的 70%）。超出量只有 849 个 token，却完全无法恢复。

两件事桥直接处理了：

- **工具结果里的图片是搬运，不是序列化。** Chat Completions 的 `role: "tool"` 消息只能装文本，工具返回的图片无处可放；把它 `JSON.stringify` 会把整个 `data:` URL 变成字面文本，上游分词器按约 1 token/字符计费。一张 1080p 截图（约 570k 个 base64 字符）实测 280k–594k 输入 token，一个工具结果就能填满 1M 上下文。现在桥把文本留在工具消息里、注明图片已移动，并在下一条 user 消息上（放在整批工具结果之后，以免破坏 assistant `tool_calls` 的配对）作为真正的 `image_url` part 重新挂上。修复后同一张 762,772 字符的截图只花 **1,100** 输入 token，模型也能正常读到图。单次最多搬运 8 张，其余按数量报告。
- **`maxPromptTokens` 在本地就拒绝。** 超过上限时桥直接回 `413` 并给出估算值，完全不接触上游：不消耗账号、不触发限流冷却，报错里写清楚了该怎么做。

把它设在真实上限**之上**一点（`1048576` 的上游用 `1200000`），估算偏高时才不会误伤本来能过的请求。估算刻意做得很粗 —— 文本约 4 字符/token、长 base64 约 1 字符/token、每张图一个固定视觉开销 —— 所以它是保险丝，不是上下文管理器。

这个默认值放在桥**自己的代码里**，而不是某个启动器的环境变量里：桥会被 DSH supervisor 拉起、被 `start-bridge.vbs` 拉起、调试时还会手工 `node bridge.mjs`，只有把默认值写进代码，换一条启动路径才不会静默失去保护。

## 范围与限制

- 只做进程监管加请求翻译。它不启动、停止或配置*上游* provider，也不对你账号能用哪些模型发表意见。
- 没有重启退避：瞬间死掉的子进程每个 `intervalMs` 会被拉起一次。如果二进制缺失或端口被别人占着，日志每轮都会说明，不会空转。
- spawn 时设了 `windowsHide: true`，被监管的控制台子进程不会在 Windows 上闪窗。
- Linux 和 macOS 用同一份代码即可；只有 `cordis.patch.yml` 里的默认路径是 Windows 专用的。
- 上游 WorkBuddy 项目已停止维护，并正在收紧反代检测。本插件能让链路活着，但保不住上游通道本身。

## 相关

- [codex-chat-bridge](https://github.com/kangjiazhen/codex-chat-bridge) —— 本插件内置的那座桥，想单独用可以去这里。
- [LiteLLM](https://github.com/BerriAI/litellm)、[one-api](https://github.com/songquanpeng/one-api)、[new-api](https://github.com/Calcium-Ion/new-api) —— 完整网关，如果你需要路由与密钥管理，而不是本地进程监管。

## 许可

MIT
