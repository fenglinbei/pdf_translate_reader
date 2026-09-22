# 模型升级生产发布记录

**已部署并完成部署检查。** 生产服务于 2026-09-22 14:49:15（Asia/Shanghai）切换到 `685cb0fa30b373cc805f6a1e18bd97e01d2e6e9d`，对应工作分支 `codex/model-support-upgrade`。本记录随后单独提交，运行代码版本以上述 SHA 为准。登录后的完整论文流程未在本次执行。

入口：[pdf-translate-reader.xyz](https://pdf-translate-reader.xyz)、[pdf.fenglin.pro](https://pdf.fenglin.pro)。两者均使用 HTTPS。

## 发布范围

- 六个核心型号：Qwen Max、Qwen Flash、GLM 5.3、GLM Flash、DeepSeek Flash、Kimi K3；GLM FlashX 作为可选高速档。未接入 Kimi 编程高速版。
- 翻译默认 `deepseek-flash`；QA 新默认仍待确认，本次生产保留 `deepseek-v4-pro`。生产 `QA_DEFAULT_CHAT_MODEL` 未设置。
- Qwen 密钥与已确认的北京业务空间地址通过 SSH 加密标准输入写入生产 `.env.local`，权限为 `0600`。其他环境变量逐项比对保持原值，服务密钥和私有 Base URL 未检出于公开前端产物。
- 保留兼容型号、已有选择和历史模型身份。Embedding 继续为 Voyage `voyage-4-large` / 1024 维，本次无需数据库迁移或重建索引。

## 部署与回滚

从 `67073c42e65d1f5d89c869119d5bdf0ef5c8dc75` 快进到发布 SHA，使用项目的 `scripts/deploy-linux-nginx.sh` 完成 `npm ci`、TypeScript / Vite 构建、静态资源发布和服务重启。沿用现有双域名与 TLS 配置；Nginx 配置和 systemd 单元与备份逐字节相同。服务器原有手工修改和历史备份均通过 SHA-256 保留检查。

构建期间使用了临时文件交换空间，构建后已关闭并删除，没有修改开机配置。构建保留原有的大 chunk 提示。

发布前已完整备份原应用（含依赖、Git 和环境文件）、网页目录、服务配置、工作区补丁与原文件校验值；两份归档均通过可读性检查。具体服务器路径、连接别名和恢复指令仅保留在服务器备份及本地内部运维记录中。

**回滚脚本已准备，本次未执行恢复演练。** 恢复流程会保留当前目录副本，恢复原应用、网页及服务配置，再重启并检查健康。

## 验证结果

发布前已通过 198 项相关断言及本地构建。生产检查结果如下：

| 检查 | 结果 |
| --- | --- |
| API 服务 / Nginx | `active`；服务重启计数 0；Nginx 配置检查通过 |
| 两个公网健康接口 | 均 HTTP 200；四家模型供应商已配置，Qwen Key / Base URL 均就绪 |
| 公网 HTML、主 JS、CSS | 两个域名均 HTTP 200；SHA-256 与服务器发布目录和生产构建一致 |
| 未登录翻译请求 | 两个域名均 HTTP 401，认证保护有效 |
| 隔离浏览器 | 两个域名正常显示登录表单；浏览器错误和警告均为 0 |
| 配置保留与密钥检查 | 原有环境变量保持原值；公开前端产物未检出服务密钥或私有 Qwen 地址 |
| 生产模型调用 | 16/16 通过，详情见下表 |

调用直接使用**生产部署的适配器与正在运行服务的环境变量**，最多两个型号并发，每次请求上限 90 秒。翻译检查使用含 300 / 400 的合成英文，核验中文结果、数字保留及流完整结束；QA 检查要求根据合成证据回答 75% 并引用 `[C1]`。另检查当前 QA 默认和非流式分类路径。没有发送用户论文或保存原始推理。

| 型号 | 翻译流 | QA 流 |
| --- | --- | --- |
| DeepSeek Flash | 通过 | 通过 |
| Qwen Max | 通过 | 通过 |
| Qwen Flash | 通过 | 通过 |
| GLM 5.3 | 通过 | 通过 |
| GLM Flash | 通过 | 通过 |
| Kimi K3 | 通过 | 通过 |
| GLM FlashX（可选） | 通过 | 通过 |

其余两项为 `deepseek-v4-pro` 默认 QA 调用与 `deepseek-flash` 分类调用，均通过。调用时间为 2026-09-22 14:51:58–14:52:25（Asia/Shanghai）。单轮短输入结果用于验证配置、接口与参数兼容，不作为质量或延迟排名。

主 JS 为 `/assets/index-BeDNBvla.js`，SHA-256 为 `c1aca0f23586e8e0635860f28922854e184d3a77c783600ee89464f6ac8fd8f7`。完整非敏感检查指标见[发布检查 JSON](model-support-production-2026-09-22.json)。

本次浏览器检查使用未登录会话；未执行登录后的论文上传、检索、引用跳转、追问或数据库保存。模型调用通过不等于这些产品流程已验收。QA 默认与旧型号退场规则仍按[模型升级说明](model-support-upgrade.md)等待确认。
