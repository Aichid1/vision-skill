---
name: vision-skill
description: 让不具备原生识图能力的模型获得识图能力，并自动控制图片尺寸/体积防止 token 爆量。当用户分享图片路径或 URL、要求分析/描述/识别图片内容，或当前模型无法直接读取图片时，使用 vision.js 调用 OpenAI 兼容格式的视觉模型（默认阿里云百炼千问）返回文字描述。
---

# Vision 识图 Skill

底层模型若不具备原生识图能力，遇到图片时**不要直接用 Read 工具读图片**，改用 `vision.js`：

```bash
node vision.js "<图片路径>" "请用中文描述这张图片的内容"
node vision.js --url "<图片链接>" "这张图片里有什么？"
```

## 触发场景

- 用户分享本地图片路径或网络图片 URL
- 消息中出现图片附件（如 "Saved attachments:" 列出的图片）
- 用户要求分析、描述、识别图片内容
- 需要 OCR、画面元素提取、图片问答

## 识图流程（重要）

每次识图前，`vision.js` 会**先检查图片的尺寸和体积，再调用模型识别**：

1. 读取图片：本地文件直接读取；URL 先下载（超过下载限制会报错）
2. 检查：最长边超过 `VISION_MAX_DIM`（默认 2048px），或体积超过 `VISION_MAX_BYTES`（默认 4MB）→ 自动缩放 + 转 JPEG 压缩
3. 压缩产物仅在内存/临时目录中使用，**不会覆盖或修改原图**
4. 压缩后 base64 仍超过 10MB → 直接报错提示，不发起识别请求
5. 通过检查后，再调用视觉模型识别，返回文字描述
6. 识别完成后自动清除压缩产生的临时文件（进程退出时兜底清理）

## 安装

需要 Node.js ≥ 18。建议用 npm 安装依赖（dotenv + sharp，用于加载 .env 和图片压缩）：

```bash
npm install
```

没有 sharp 时，Windows 上会自动回退到 PowerShell System.Drawing 压缩；其他平台则只做体积检查。

## 配置要求

脚本通过环境变量或同目录 `.env` 文件读取配置（参考 `.env.example`）：

- `DASHSCOPE_API_KEY`：阿里云百炼 API Key（默认服务商）
- `VISION_MODEL`：视觉模型名，例如 `qwen3.5-omni-plus` / `qwen-vl-max` / `gpt-4o-mini`
- `DASHSCOPE_BASE_URL`：非千问服务时改成对应 OpenAI 兼容地址
- `VISION_MAX_DIM`：图片最长边上限（像素），默认 `2048`，超出自动缩放
- `VISION_MAX_BYTES`：图片体积上限（字节），默认 `4194304`（4MB），超出自动压缩
- `VISION_QUALITY`：压缩后 JPEG 质量，默认 `85`；`VISION_RESIZE=off` 可关闭自动压缩
- `VISION_SHARP_PATH`：sharp 模块绝对路径（一般无需设置，脚本自动探测运行时内置版本）

未配置时提示用户申请 Key：https://bailian.console.aliyun.com/

## 使用说明

1. 确认 Node.js 可用（`node -v`，需 ≥ 18）
2. 每张图片依次执行 `vision.js`，拿到全部文字描述后再回复用户
3. 网络受限时请确保脚本能访问外网（防火墙/代理放行 API 域名）

## 注意事项

- 只传图片路径或 URL，不要传图片二进制内容给脚本
- 图片会自动压缩：最长边超过 2048px 或体积超过 4MB 时自动缩放并转 JPEG（优先 sharp，Windows 回退 PowerShell），避免大图导致 token 爆量；阈值可用环境变量调整
- 压缩后的图片不覆盖原图，仅用于本次识别；识别完成后临时文件自动清除
- 一次多张图片时逐张处理，避免遗漏
- 识图失败时检查 API Key、模型名和网络连接