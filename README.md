# 游览向导（Bard）

以「资源包」为内容单位的景物游览微信小程序。每个资源包只讲一处景物——一座寺院、一窟石刻、一条古街——用户打开后沿预设路线逐幕滑动，画面、正文与讲解音频同步推进，形成一段可离线收听的深度游。

小程序端用微信原生框架实现，只做通用「分镜播放器」；内容全部是数据。服务端负责 AI 生成资源包、发布与分发。

## 内置资源包

| 资源包 | 幕数 | 讲述人 |
|---|---|---|
| 洛阳白马寺 | 8 | 武则天 |
| 洛阳龙门石窟 | 8 | — |
| 洛阳关林 | 10 | — |
| 洛阳山陕会馆 | 5 | — |
| 洛邑古城 | 6 | — |
| 洛阳博物馆 | 5 | — |
| 老君山 | 6 | — |
| 洛阳丽景门 | 5 | — |
| 少林寺 | 9 | — |
| 应天门遗址博物馆 | 5 | — |

在线资源包由服务端生成后发布到 `cdn/`，清单在 `cdn/manifest.json`，客户端按需下载。

## 功能

- **分镜游览**：竖向 `swiper` 切幕，背景图 + 遮罩 + 立绘 + 正文分层错峰入场，转场由资源包逐幕声明；
- **讲解音频**：豆包在线 TTS（`seed-tts-2.0`，44.1kHz），按讲述人自动匹配音色；音频不进包体，统一发布在 `cdn/audio/{packId}/`；
- **离线收听**：下载资源包时自动把全部讲解音频存到本地，播放本地优先、缺失回退 CDN；新包生成完成后自动下载包体与音频，提示「已下载，可离线游览」；
- **AI 生成资源包**：提交「景点-人物」即可生成——检索资料 → 编幕大纲 → 撰写文稿 → 逐幕出图 / 绘制立绘 / 逐幕配音（三条分支并发）→ 装配发布；同景点同讲述人只保留一个包，原地刷新并递增版本；
- **包内问答**：游览页浮窗回答路线、周边与包内内容问题，带 `pois` 的包可列周边点位与餐饮；
- **分享直达**：分享链接带 `?pack=id`，接收方直接进入对应资源包；
- **分包加载**：10 个内置包各自是独立资源分包，`wx.loadSubpackage` 按需加载，主包只含页面代码与封面。

关键约束：

- 语音只由用户点击「收听讲解」触发，切幕或离开页面立即停止；
- 不使用 `filter: blur`、`backdrop-filter`、`clip-path` 等重绘属性；单幕同时参与动画的元素不超过 6 个；
- 主包与单个资源分包均不得超过 2MB，列表封面单张不超过 80KB。

## 工程结构

```
miniprogram/
  app.json                 页面与分包声明
  config.js                CDN_BASE / API_BASE / API_TOKEN
  pages/
    launch/                欢迎动画
    packs/                 资源包列表：提交生成、下载、存音频
    tour/                  游览页（核心播放器）
  components/
    scene/                 单场景：背景、遮罩、立绘、正文、操作层
    markdown/              轻量 Markdown 渲染（v2 正文）
    route-bar/             顶部路线进度
    guide/                 游览浮窗问答
  core/
    loader.js              资源包解析、本地化回退、分包与本地包读取
    remote.js              远端清单与文件地址
    task.js                生成任务提交与轮询
    cache.js               在线包与讲解音频的落盘、校验与淘汰
    audio.js               讲解音频播放（本地优先）
    preload.js             下一幕素材预热
  packs/                   10 个内置包（各自分包）与构建期生成的 registry.js
  covers/                  列表封面缩略图
server/                    Fastify + TypeScript + node:sqlite，api / domain / infra 分层
  src/api/                 路由与请求校验
  src/domain/              任务编排、去重、文稿与人物音色规则
  src/infra/               千问出图与文稿、豆包 TTS、CDN 存储、SQLite
cdn/                       在线包发布目录、manifest.json 与 audio/
tools/                     装配、校验、清单生成、封面与素材转换脚本
docs/                      技术方案与生成规范
```

职责边界：页面只管生命周期与跳转，组件只管渲染，`core/*` 不依赖页面，资源包读取一律经由 `loader.js`。

## 快速开始

### 小程序

用微信开发者工具导入仓库根目录（`project.config.json` 已指定 `miniprogram/` 为代码根目录）。只读内置包时无需启动服务端；要在列表看到并下载在线包，需要先启动服务端，并在 `miniprogram/config.js` 中配置 `CDN_BASE` / `API_BASE`。

### 服务端

```bash
cd server
npm install
# 新建 .env，按下表填入需要的密钥
npm run dev            # 默认 8788，静态发布 + 任务编排
```

常用环境变量：

| 变量 | 作用 |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 文稿模型（通义千问兼容接口），缺 Key 时生成任务明确失败 |
| `IMAGE_API_BASE_URL` / `IMAGE_API_KEY` / `IMAGE_API_MODEL` | 出图服务，配图与立绘全部由它生成 |
| `DOUBAO_TTS_API_KEY` / `DOUBAO_TTS_SPEAKER` | 豆包语音合成 2.0，缺 Key 时该幕无音频、按钮置灰 |
| `AUDIO_EAGER_SCENES` | 主任务同步配音幕数，`0`（默认）为全量同步 |
| `API_TOKEN` | 设置后 `POST /tasks` 与 `GET /metrics` 需带 `x-api-token` |
| `TASK_QUEUE_MAX` / `TASK_RATE_LIMIT` | 队列上限与单来源提交限流 |

### 资源包制作

```bash
node tools/assemble-pack.js --content packs-src/{id}/content.json \
     --assets packs-src/{id} --out cdn/{id}   # 文稿 → pack.json → 转图 → 校验
node tools/validate-pack.js --dir cdn         # 校验在线包
node tools/validate-pack.js                   # 校验内置包与分包体积
node tools/build-covers.py                    # 生成主包内的列表封面
node tools/build-pack.js                      # 重建 miniprogram/packs/registry.js
node tools/build-manifest.js                  # 扫描 cdn/ 重建 manifest.json
node tools/editor/server.js                   # 可视化编辑器，端口 8790
```

质量门禁：

```bash
cd server && npm run typecheck && npm test    # 类型检查与全量单测
```

## 文档

- [技术方案](docs/技术方案.md)：选型、资源包规范、播放器、音频与生成流水线、分发、里程碑
- [生成规范](docs/生成规范.md)：`content.json` 契约、文稿规则、配图规则、装配与校验闸门

## 贡献者

- [mai-zi208](https://github.com/mai-zi208)
- [rommelida722-boop](https://github.com/rommelida722-boop)
- [Lumiray92](https://github.com/Lumiray92)
- [1104-su](https://github.com/1104-su)
- [luochen325](https://github.com/luochen325)
