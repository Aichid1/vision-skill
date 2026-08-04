# vision-skill

让没有原生识图能力的模型/程序获得识图能力：把图片发给支持 OpenAI 兼容格式的视觉模型（默认阿里云百炼千问），返回文字描述。内置**自动图片压缩**，避免大图导致 token 爆量和请求失败。

## 特性

- OpenAI 兼容格式，任意服务商可用（千问 / GPT-4o-mini / 其他）
- 自动压缩：最长边 > 2048px 或体积 > 4MB 自动缩放转 JPEG（防 token 爆量）
- 压缩产物不覆盖原图，识别完成后自动清理临时文件
- 支持本地图片路径与网络 URL
- 零强依赖：优先 sharp，Windows 无 sharp 时自动回退 PowerShell System.Drawing
- 可作为 Codex / Claude Code 等 Agent 的 skill 使用（内置 `SKILL.md`）

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/Aichid1/vision-skill.git
cd vision-skill
npm install          # 可选：安装 dotenv + sharp
```

### 2. 配置 API Key

复制 `.env.example` 为 `.env` 并填写：

```bash
cp .env.example .env
```

```dotenv
DASHSCOPE_API_KEY=sk-xxx
VISION_MODEL=qwen-vl-max
```

也可以直接用环境变量：`export DASHSCOPE_API_KEY=sk-xxx`

> 没有 Key？去 https://bailian.console.aliyun.com/ 申请（新用户有免费额度）。

### 3. 使用

```bash
# 本地图片
node vision.js "图片路径" "请用中文描述这张图片的内容"

# 网络图片
node vision.js --url "https://example.com/a.jpg" "这张图片里有什么？"
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | - | 视觉模型 API Key（必填） |
| `VISION_MODEL` | `qwen-vl-max` | 视觉模型名 |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容 API 地址 |
| `VISION_MAX_DIM` | `2048` | 图片最长边上限(px)，超出自动缩放 |
| `VISION_MAX_BYTES` | `4194304` | 图片体积上限(Byte)，超出自动压缩 |
| `VISION_QUALITY` | `85` | 压缩后 JPEG 质量 |
| `VISION_RESIZE` | `on` | 设为 `off` 关闭自动压缩 |
| `VISION_SHARP_PATH` | 自动探测 | sharp 模块绝对路径（一般无需设置） |

## 作为 Codex Skill 使用

把整个仓库目录放到 Codex 的 skills 目录（如 `~/.codex/skills/vision-skill`），Codex 遇到图片时会自动调用 `vision.js`。`SKILL.md` 中包含完整的触发场景、识图流程与注意事项。

## 工作原理

1. 读取图片（本地文件或下载 URL）
2. 检查尺寸与体积，超限自动缩放转 JPEG（仅内存/临时文件）
3. base64 后以 OpenAI 兼容格式调用视觉模型
4. 返回文字描述，临时文件自动清理

## 协议

MIT License，详见 [LICENSE](LICENSE)。