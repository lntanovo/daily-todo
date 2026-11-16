# QQ 机器人入口（`bot/`）

这是[「今天算数 · Make Today Count」](../README.md) 的聊天侧入口：**网站在云端存数据，QQ 机器人负责随手记和到点追问，企业微信负责提醒**。
三块共享同一份 PostgreSQL 数据，所以在哪里记、在哪里勾，看到的都是同一份日程。

> 只想用网站的话，这个目录可以完全忽略；它需要 Windows + 一直挂着的 QQ 客户端。

| 组件 | 代码位置 | 跑在哪 | 干什么 |
|---|---|---|---|
| 日程网站（Vite + CloudBase 静态托管） | 本目录的上一级（站点仓库根） | 云端静态托管 | 任务增删改查、完成打勾、专注计时、完成热力图、备份恢复、提醒设置 |
| 云端提醒引擎（云函数 `reminder-tick`） | 同上 `cloudfunctions/` | CloudBase，每分钟定时触发 | 到点提醒、早报、晚间收尾，推到企业微信 |
| QQ 机器人（AstrBot + SnowLuma + 插件） | 本目录 | 这台 Windows，QQ 挂着时 | 私聊随手记、多条目抽取、到点追问完成、开机补拉、每日简报 |

- 公网站点：<https://daily-todo-d3gq5mama7a468d02-1485775300.tcloudbaseapp.com>
- 云端环境：`daily-todo-d3gq5mama7a468d02`（上海，体验版，2027-03-12 到期）
- 本机控制台：AstrBot <http://127.0.0.1:6185>，SnowLuma <http://127.0.0.1:5099>

## 数据流

```
                    ┌──────────────────────────────┐
  网站（浏览器） ───▶│                              │
                    │  CloudBase PostgreSQL        │
  QQ 私聊 ──▶ 插件 ─▶│  todo_tasks                  │──▶ reminder-tick（每分钟）
   （AstrBot）      │  todo_daily_completions      │      ├─ 到点提醒
                    │  todo_task_recurrences       │      ├─ 早报 08:00
                    │  todo_daily_notes / 专注 / 模板│      └─ 晚间收尾 20:30
                    │  todo_reminder_settings/log  │              │
                    └──────────────────────────────┘              ▼
                                                          企业微信群机器人
```

**核心决策：真相源在云端，不在机器人。** 提醒要 7×24 跑，而 QQ 这条链路依赖
Windows + QQ 客户端 + 注入，是最脆弱的一环；机器人只是入口，挂了也不影响提醒。

## 功能

### 网站（主界面）
- 任务三种形态：单日、连续多日（含首尾）、重复（每日 / 每周指定星期 / 每月指定日，月末不存在的日期跳过）；
- 完成打勾按「任务 + 日期」独立记录，重复任务每天互不影响；完成历史进快照表，个人页有 365 天热力图与连续天数；
- 每天每任务最多 500 字「当日补充」，完成任务不删补充；
- 专注页番茄钟（关联任务、暂停/继续/提前结束、最近七天统计，云端同步）；
- 导入：粘贴编号文本、读 Markdown / Word；导出：Markdown / Word（可读清单）与 ZIP 完整备份（可校验、按类别合并）；
- 外观：Warm Paper 主题、私有背景上传、像素宠物、花瓣动效、可换字体；
- 提醒设置：Webhook（页面只显示尾号四位）、早报时间、宽限、免打扰、**提前几天开始倒计时**、晚间收尾时间。

### 提醒（云函数，不依赖这台电脑）
- 每分钟 `reminder-tick`：领取到点的任务 → 推企业微信 → 记 `todo_reminder_log`（幂等，多实例不会重复发）；
- **早报**：逾期 + 今天 + 未来 N 天倒计时；**晚间收尾**：今天还没做完的；
- 连续多日任务只进汇总，不逐条轰；提醒消息里带「标记完成」链接（token 签名，有效期有限）；
- 飞书通道代码在，但当前只配了企业微信。

### QQ 机器人（随手记入口）
- **私聊记日程**：一句话或一整段通知都行。先把原文切成编号段 → 模型逐段抽 → 代码校验有没有漏段 → 漏了用小 prompt 补抽；一段里四场培训就出四条，不再只认第一条；
- **先回执再落库**：一次列 N 条，回 `1` 全存、`1 3` 只存这两条、`2` 全不要、`重试` 重解析；闲聊不拦截，照常陪聊；
- **到点追问完成**：任务过了自己的时间 + 15 分钟还没勾，私聊问一次「完成了吗」，回 `完成` / `1 3` / `没做`，确认后直接写 `todo_daily_completions`（和网页上打勾是同一件事）；
- **每日简报**：私聊说「每天 9 点提醒我」这类话即设置，到点发逾期 / 今天 / 未来几天的清单；
- **开机补拉**：关机期间漏掉的私聊，开机后逐条问确认，确认前不写云端；
- **群聊旁听**：`watch_groups` 里的群可以静默抽日程（`event.stop_event()` 收尾，绝不发言），目前**未启用**；`chat_groups` 走 AstrBot 原生陪聊；
- 指令（仅 `admins_id`）：`/任务` `/日程` `/提醒` `/每日提醒 09:00` `/绑定` `/详情 <id>` `/完成 <id>` `/取消 <id>` `/待确认` `/状态`。

## 目录结构

本目录（`bot/`，机器人侧）：

```
bot/
├─ README.md                    ← 你正在看的这份
├─ Start-All.cmd                ← 一键启动 AstrBot + SnowLuma（推荐）
├─ Start-AstrBot.cmd / Start-SnowLuma.cmd
├─ astrbot_plugin_agenda/       ← 插件源码（唯一需要改的地方）
│  ├─ main.py                   ← 消息入口、确认流程、追问循环
│  ├─ capture.py                ← 私聊多条目：切分→编号→覆盖校验→补抽
│  ├─ followup.py               ← 「完成了吗」的判定、文案、回复解析
│  ├─ extractor.py              ← 群聊批量抽取的 prompt 与解析
│  ├─ cloud_reader.py           ← 读云端任务（/任务、简报、追问）
│  ├─ cloud_writer.py           ← 写云端任务 / 标记完成
│  ├─ intent.py / catchup.py / store.py / guard.py
│  └─ views/groups/             ← Dashboard 里的「群策略」页面
├─ tests/                       ← 119 项单测（含真实 handler 的集成测试）
├─ scripts/                     ← 启动、装插件、自检、真机验证脚本
├─ config/                      ← 人格提示词、插件配置样例、本机凭据笔记
├─ docs/
│  ├─ HANDOFF.md                ← 交接/现状文档（踩过的坑都在里面）
│  └─ archive/                  ← 早期计划与 AstrBot 笔记（历史，别当现状读）
├─ astrbot/                     ← AstrBot 运行数据（配置、插件副本、日志、SQLite），不入库
├─ tools/snowluma/              ← QQ 协议端（第三方运行时，177 MB），不入库
│                                 发行包 zip 已删；重装按 v2.4.2 win-x64 重新下载
└─ .uv/                         ← astrbot 启动器，不入库
```

站点侧（本目录的上一级，即站点仓库根）：`src/` 前端源码、`index.html` 单页入口、
`cloudfunctions/` 云函数、`cloudbase/migrations/` 数据库迁移、`tests/` 前端测试、`dist/` 构建产物。

## 启动

```powershell
# 机器人（先 AstrBot 开 6199，再 SnowLuma 反连；QQ 必须登录着）
Start-All.cmd

# 站点本地开发
cd ..
npm install ; npm run dev
```

- SnowLuma 是**注入式**协议端：QQ 客户端必须一直开着，**不要点「退出登录」**，QQ 也别升级；
- 三个端口只绑 `127.0.0.1`，不要改成 `0.0.0.0`；
- 开机自启：`scripts\enable-autostart.ps1`（计划任务 `DeepSeek-QQ-Bot`），取消用 `disable-autostart.ps1`。

## 改了代码之后

```powershell
# 插件：改完必须重装副本 + 重启 AstrBot（没有热重载）
powershell -ExecutionPolicy Bypass -File scripts\install-plugin.ps1
# 然后关掉 AstrBot 窗口重新 Start-All.cmd

# 站点：构建并部署
cd ..
npm run check ; npm run build
tcb hosting deploy dist -e <envId>
```

## 配置与密钥

| 放哪 | 是什么 |
|---|---|
| AstrBot Dashboard → 插件 → 群聊日程助手 | `cloud_env_id` / `cloud_api_key` / `owner_id`、抽取模型、追问开关、群策略 |
| `config/local-notes.md`（gitignore） | 本机凭据与地址笔记 |
| `%TEMP%\dsh-tcb-secrets.json` | 部署用 CloudBase API Key（tcb CLI） |
| `../.env.local`（gitignore） | 站点 Publishable Key |
| 云端环境变量 | `reminder-tick` 的 `APP_ENV_ID` / `CLOUDBASE_API_KEY` / `REMINDER_BASE_URL` |

**密钥不进仓库、不进文档、不截图。** 文档里只写位置。

## 数据

云端 PostgreSQL（每张表都按 `owner_id` 做 RLS）：

| 表 | 作用 |
|---|---|
| `todo_tasks` | 任务本体（`type` = single / range / recurring） |
| `todo_task_recurrences` | 重复规则（weekly 星期几 / monthly 几号） |
| `todo_daily_completions` | **完成状态**：主键 `owner_id + task_id + completion_date`，`completed = true` 即打勾 |
| `todo_completion_history` | 完成历史快照（由触发器维护） |
| `todo_daily_notes` | 每条任务每天的补充 |
| `todo_focus_sessions` / `todo_task_templates` / `todo_preferences` | 专注、模板、外观 |
| `todo_reminder_settings` | Webhook、早报/晚间时间、提前天数、免打扰 |
| `todo_reminder_log` | 投递账本（`kind` 区分 due / digest / digest_pm，保证不重发） |

本机 SQLite `astrbot/data/plugin_data/astrbot_plugin_agenda/agenda.db` 只存
**入口侧的临时状态**：群聊原文、待确认草稿、开机补拉队列、追问记录、token 用量。
任务本身永远只在云端。

## 测试

```powershell
# 机器人侧（在 bot/ 目录里跑；用装过 astrbot 的 python 才能跑集成测试，否则自动跳过 5 项）
cd bot
python -m unittest discover -s tests -t .

# 站点侧
cd ..
npm run check ; npm run test:features ; npm run test:reminder ; npm run test:optimizations
```

另外两个真机脚本：`python scripts\bench_capture.py`（拿真实模型跑多条目抽取对比）、
`python scripts\verify_complete.py`（真实云端插入→读回→删除，验证「标记完成」）。

## 已知边界

- **QQ 链路依赖这台电脑和 QQ 客户端**：电脑关机时收不到消息，开机后补拉；提醒本身在云端，不受影响。
- `watch_groups` 目前是空的，群聊旁听还没开（要开：填群号 + 把群号加进 AstrBot 白名单）。
- `agenda-ingest` 云函数部署了但路由返回 403，暂未启用（机器人直接走 PostgREST 写库）。
- 单 owner 设计：`owner_id` 只有一个，别人（注册用户）的数据机器人看不到也不会去碰。
- 体验版 CloudBase 有配额与域名限制，到期 2027-03-12。
- 到点追问只覆盖「今天」（含跨零点 12 小时内的昨日项），更早的逾期只在早报里列。

## 文档索引

| 文件 | 内容 |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | **现状与踩坑记录**：架构决策、已验证/未验证清单、常用命令、已知坑、下一步 |
| [astrbot_plugin_agenda/README.md](astrbot_plugin_agenda/README.md) | 插件自己的说明（抽取流程、配置项、指令） |
| [config/local-notes.md](config/local-notes.md) | 本机凭据与地址（不入库） |
| [`../README.md`](../README.md) | 站点功能、开发命令、版本记录 |
| `../docs/` | 提醒功能部署手册、验收记录 |
| `docs/archive/` | 早期计划与 AstrBot 源码笔记（历史归档，不入库） |

## 最近的三个大改动

1. **11-16 私聊多条目**：旧实现只接受单个 `item`，一段话里四件事只能记下一件；改成
   分段编号 + 覆盖校验 + 补抽后，同一条通知 4/4 全中（细节见 `docs/HANDOFF.md` 第 12 节）。
2. **11-16 到点追问完成**：过了任务时间没勾 → 私聊问一次 → 回「完成」直接写
   `todo_daily_completions`，和网页打勾同源（第 13 节）。
3. **11-17 仓库整理**：删掉 AstrBot 源码克隆（`vendor/`，24 MB）、QQ 图片缓存（44 MB）、
   早期残留数据目录与一次性诊断报告；历史文档归档进 `docs/archive/`。
