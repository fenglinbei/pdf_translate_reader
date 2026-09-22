# 模型支持升级（2026-09-22）

当前交付：统一模型目录、翻译与论文问答适配已实现，并通过本地回归、构建及开发环境实调用。基础合成样例与首轮公开中英文论文评测均已完成，后者的[报告与默认建议](public-paper-model-evaluation-2026-09-22.md)待确认。尚未部署生产；模型样例不等于完整产品流程验收。

## 已确认的范围与默认策略

| 定位 | 显示型号 | API 模型 ID | 供应商 | 思考能力 |
| --- | --- | --- | --- | --- |
| 核心 | Qwen Max | `qwen3.8-max` | 阿里云百炼 | 可关闭；`low / medium / xhigh` |
| 核心 | Qwen Flash | `qwen3.8-flash` | 阿里云百炼 | 可关闭；`low / medium / xhigh` |
| 核心 | GLM 5.3 | `glm-5.3` | 智谱 | 强制开启；`low / high / max` |
| 核心 | GLM Flash | `glm-5.3-flash` | 智谱 | 强制开启；`low / high / max` |
| 核心 | DeepSeek Flash | `deepseek-flash` | DeepSeek | 可关闭；`high / max` |
| 核心 | Kimi K3 | `kimi-k3` | Moonshot | 强制开启；`low / high / max` |
| 可选高速档 | GLM FlashX | `glm-5.3-flashx` | 智谱 | 强制开启；`low / high / max` |

- 翻译默认 **DeepSeek Flash**。新用户及无效设置使用该默认；已保存且仍受支持的选择保持原值。
- 论文问答新默认值 **待代表性论文评测后冻结**。当前暂保留原有 `deepseek-v4-pro`，不代表它是本轮选定的核心型号。`QA_DEFAULT_CHAT_MODEL` 仍可设置目录中已适配的型号。
- FlashX 可手动选择，不作为默认；不接入 `kimi-k2.7-code-highspeed`。
- `deepseek-v4-flash`、`deepseek-v4-pro`、`glm-5.2` 暂作兼容项，保留原有调用范围与历史身份。**旧型号何时停止新请求、已保存选择如何迁移仍待确认**；本轮不静默改写历史模型。
- 使用版本化的当前型号 ID，不用 `qwen-max` 等可能指向旧代的泛称。DeepSeek 官方当前 Flash ID 是 `deepseek-flash`，历史 V4 Flash 记录仍显示原型号。

## 实现位置

- `shared/modelCatalog.json`：唯一的模型 ID、默认值、供应商、核心/可选/兼容分类、任务就绪状态、上下文/输出上限、推理能力与映射。
- `shared/modelRegistry.mjs` 和 `.d.mts`：浏览器与 Node 共用访问函数；TypeScript ID 从 JSON 推导，不另维护枚举。历史可识别与当前可选择分别判断。
- `server/models/providerConfig.mjs`：仅服务端读取密钥与 Base URL。前端目录、健康检查、构建产物不包含密钥。
- `server/models/requestBody.mjs`：供应商参数适配；翻译和问答共用，DeepSeek 原有翻译流保留兼容路径。
- 翻译选项、自由翻译草稿/历史、设置默认、用量统计、论文问答选项、QA 日志与上下文预算均接入目录。

新增模型必须同时声明能力并实现适配；`pending` 不进入可选列表。未知 API 请求模型返回错误，不转发给其他厂商。未知 QA 上下文配置报错，不假定为 1M。

## 参数与运行配置

Qwen 使用 `ALIYUN_API_KEY` 与 `ALIYUN_API_BASE_URL`；兼容别名是 `DASHSCOPE_API_KEY` 与 `QWEN_API_BASE_URL`。Base URL 必须取自同一地域/业务空间的控制台，不设置跨地域兜底。本地已按确认地址配置北京业务空间；实际地址和密钥不进入仓库。健康检查仅返回是否已配置。

其他厂商沿用 `DEEPSEEK_API_KEY`、`GLM_API_KEY`、`KIMI_API_KEY` 及原有 Base URL 配置。阿里云 Key 仅用于 Qwen，其他型号继续使用各自官方 API，避免平台间 ID 与参数差异。

- Qwen 使用顶层 `enable_thinking`。本地翻译低/高/最大映射为 `low / medium / xhigh`；问答标准/深度映射为 `medium / xhigh`。不同时传 `thinking_budget`。
- GLM 5.3 系列始终发送 `thinking.type=enabled`。问答快速档、分类器和检索控制器使用 `low`，不再发送 `disabled` 或 `none`。
- Kimi 使用 `max_completion_tokens`，省略 `thinking` 及固定采样参数。其快速/标准/深度档为 `low / high / max`。
- DeepSeek 与 Qwen 快速档关闭思考。思考开启时不强行传低温度；GLM 5.2 的历史配置继续兼容。
- 不再读取 `DEEPSEEK_QA_MODEL`、`GLM_QA_MODEL` 等隐式覆盖项：实际请求模型与选择、日志、能力和预算来自同一目录。需要切换默认时使用 `QA_DEFAULT_CHAT_MODEL`。
- Qwen/GLM 翻译默认输出上限 16,384，分别由 `QWEN_TRANSLATION_MAX_TOKENS`、`GLM_TRANSLATION_MAX_TOKENS` 调整；Kimi 使用 `KIMI_TRANSLATION_MAX_COMPLETION_TOKENS`，默认同为 16,384。QA 保持每次请求默认 32,768 的输出预算。
- QA 对空答案、截断或异常结束返回失败，不保存为成功；用量支持嵌套缓存和 reasoning token 字段。没有 usage 的响应可以正常处理。
- QA 服务端每 10 秒发送心跳；浏览器改为 180 秒无活动超时，并保留 10 分钟总时限和主动取消。Nginx 使用 SSE 禁缓冲响应头，减少思考/检索期间误断开。

当前 QA 每次调用都由 `system + user` 重新构建任务，将会话摘要与检索工具结果放入 user 内容，未使用供应商原生 tool-call 多轮协议。因此没有缺失 reasoning 的 assistant/tool 消息回传。以后若引入原生工具循环，需单独实现各供应商完整消息的短期保留与回传，不把当前适配视为已支持该协议。

## 验证证据

本地 Node 24.19.0；TypeScript 检查与 Vite 构建通过。198 项模型、翻译、问答、设置相关断言通过，包含 QA 心跳/空闲超时/总时限/取消与流异常清理。构建存在原有的大 chunk 提示。

测试执行时本机 `node --test` 汇总只显示文件级结果；为确认断言实际执行，逐文件运行 `node tests/...test.mjs` 并检查详细通过数。没有仅依赖文件级汇总。

实调用使用 `.env.local` 中开发凭据，未发送用户论文，未落盘原始推理过程。记录见 [合成样例结果](model-support-evaluation-2026-09-22.json)。最终 7 × 5 个样例均通过：翻译、生产分类提示、证据计算、证据不足、公式追问。分类项是生产提示的单独复测；初轮简化提示的 4 次类别偏差保留在记录中，不能当作模型质量结论。

| 型号 | 翻译 | 生产分类 | 三个 QA 样例 | QA 单次平均耗时 |
| --- | --- | --- | --- | --- |
| DeepSeek Flash | 通过 | 通过 | 3/3 | 1.94 秒 |
| Qwen Max | 通过 | 通过 | 3/3 | 5.13 秒 |
| Qwen Flash | 通过 | 通过 | 3/3 | 3.31 秒 |
| GLM 5.3 | 通过 | 通过 | 3/3 | 3.87 秒 |
| GLM Flash | 通过 | 通过 | 3/3 | 2.67 秒 |
| Kimi K3 | 通过 | 通过 | 3/3 | 6.24 秒 |
| GLM FlashX | 通过 | 通过 | 3/3 | 1.53 秒 |

单轮、短输入、每型号三个 QA 问题的耗时仅描述本次开发环境样本，不是吞吐基准，也没有覆盖大论文、并发、深度档、真实引用定位或完整浏览器—数据库流程。上下文预算仍沿用字符数估算，未实测 1M 极限或大篇幅中文/公式输入。自动判分只检查数字/引用等少量条件，输出保留供人工复核。

复现（会调用计费 API）：

```bash
npm run test:models
npm run test:translation
npm run test:qa
npm run build
node scripts/evaluate-model-support.mjs --run --include-optional --output=/tmp/model-evaluation.json
# 只重测实际分类器
node scripts/evaluate-model-support.mjs --run --include-optional --only-router --output=/tmp/model-router-evaluation.json
```

## 后续冻结与发布

1. 首轮公开论文已完成 56 次调用，覆盖总结、公式解释、引用、证据不足和连续追问；已建议 DeepSeek Flash，等待确认 QA 默认值。后续继续补充跨学科与更多长文样例。
2. 确认旧型号退场及保存偏好的迁移规则；历史记录不改写模型身份。
3. 发布时把同一地域/业务空间的 Qwen 环境配置写入服务器，执行部署后健康检查和登录态端到端验证。当前仅开发环境实调用通过，不代表服务器已配置或升级。

生成模型升级不改 embedding 模型或维度；不需要因此重建向量索引。数据库模型字段是文本，本次无需模型枚举迁移。

## 官方依据（核验于 2026-09-22）

- [Qwen Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)、[Qwen Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[OpenAI 兼容参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。
- [GLM 5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM Flash / FlashX](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)。
- [DeepSeek 当前型号及参数](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[更新记录](https://api-docs.deepseek.com/zh-cn/updates/)。
- [Kimi K3 调用要求](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[Kimi 型号目录](https://platform.kimi.com/docs/models)。
