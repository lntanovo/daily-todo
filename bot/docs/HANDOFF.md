# 交接文档 — 2026-11-16 13:40（Asia/Shanghai）

> 给"新开的窗口/下一个我"看。目标是**接手就能动手**，不用重新摸一遍现状。
> **入口文档是仓库根目录的 [README.md](../README.md)**（系统全貌、启动、配置、数据模型）；
> 本文只写"现状 + 踩过的坑 + 下一步"，两份冲突时以 README 的功能描述为准。
> 旧笔记已归档到 `docs/archive/astrbot-notes-2026-11.md`（11-13 写的 AstrBot/SnowLuma 用法，
> 其中"当前状态"部分已经过期）。
>
> **2026-11-16 14:15 更新**：QQ 私聊已真机实测通过，开机补拉已实现并实测（第 2/7/8 节）。
> **2026-11-17 更新**：新增 §12 多条目抽取、§13 到点追问完成；仓库做过一次清理（见 §14）。
> 文中 `D:\...` 是作者本机的绝对路径，照着看思路即可，跑的时候按你的实际目录替换。

---

## 0. 三条铁律（先看这个，能省你半小时）

1. **不要用 PowerShell 改含中文的 UTF-8 文件。**
   `Get-Content -Raw` + `-replace` + `Set-Content` 会按错误编码读写，把整个文件变成乱码
   （2026-11-17 又踩了一次，靠上下文重写了本文）。改文件只用 `read` / `edit` / `write` 工具。
2. **密钥只在本机，不要写进任何仓库或文档。**
   凭据在 `%TEMP%\dsh-tcb-secrets.json`（`envId` / `apiKey` / `agendaOwnerId` / `agendaBotSecret`），
   部署配置在 `D:\codex\project\日程安排\cloudbaserc.json`（已 gitignore）。
   文档里只写位置，不写值。
3. **不要 `git commit` / `git push`。** 两个项目都有大量未提交改动，用户没要求提交。

---

## 1. 用户要什么（原话提炼）

- 用自己的**主号私聊 QQ bot**，说一句话（作业截止、讲座时间），bot 识别后**记下来**。
- **定时提醒**，而且要"**提前几天就开始每天提醒**"，不是只在当天提醒。
- 还要能问"**我最近有什么没完成**"。
- 记录要能和他的**日程站点**（daily to do）结合，而不是另起一份数据。
- 主号私聊要**先回执确认**再落库（用户明确选了"需要回复确认"）。
- 电脑**平时只在 12 点到 2 点开着**（点：是中午 12:00–14:00 还是到凌晨 2:00，**尚未确认**）。
  用户已接受"QQ/飞书只在开机时可用"，因为提醒本身跑在云上。
- 任务过了时间要**主动问是否完成**，确认完成后自动标记完成（2026-11-16 追加，见 §13）。

---

## 2. 现状总览

| 组件 | 状态 | 证据 |
|---|---|---|
| 日程站点（Vite + CloudBase） | 在线 | `https://daily-todo-d3gq5mama7a468d02-1485775300.tcloudbaseapp.com` |
| 云端提醒引擎（reminder-tick） | 已部署新代码 | 手动 invoke 返回 `{"due":0,"digest_am":0,"digest_pm":0}` |
| 每分钟定时触发器 | 已创建 | `tcb fn detail reminder-tick` → `reminder-every-minute：{"cron":"0 */1 * * * * *"}` |
| 企业微信推送 | 已实测送达 | 2026-11-16 02:00:04 到点提醒、02:00:05 早报，`todo_reminder_log` 两条 `sent` |
| 倒计时/晚间收尾迁移 | 已应用 | 新列 3 个、`digest_pm` 已进约束、三参 `reminder_digest_batch` 存在 |
| 站点前端（含提醒设置区） | 已部署 | 线上页面含 `reminderLeadDays` / `reminderEvening` / `reminderEveningTime` |
| QQ bot 接入层 | 运行中 | AstrBot 6185/6199 + SnowLuma 5099，OneBot 反向连接已建立，小号在线 |
| QQ 私聊捕获 → 云端写库 | 已实测 | 13:49 私聊「周五 23:59 交作业」→ 草稿 → 回「1」→ `todo_tasks` 写入 `f4a5777f…`；重复确认返回"已有，没有重复添加" |
| 一段话多件事 | 已修复（§12） | 4 场培训通知 → 4 条，日期全对 |
| 到点追问完成 | 已上线（§13） | 17:09:59 真实问出 2 项，`followups` 两行 `asked` |
| 群聊静默旁听 | 未启用 | 插件 `watch_groups` 仍是 `[]` |
| 开机补拉 | 已实现并实测 | `catchup.py` + `catchup` 队列；13:54 补拉 1 条、逐条问确认、确认后走云端去重 |
| 每日任务简报 | 已实现 | 私聊说「每天 9 点提醒我」→ 到点私聊发任务总览（逾期/今天/未来 3 天）；`/每日提醒` 可查/改/关 |
| 博客 / 云服务器 | 已搁置 | 用户决定先不做，继续把 bot 跑顺 |

---

## 3. 架构（当前实际形态）

```
主号 QQ ──私聊──> 小号 QQ ──SnowLuma(注入)──> AstrBot(:6199)
                                              └─ astrbot_plugin_agenda
                                                    ├─ 私聊：切分→逐段解析→回执→用户回 1 → 直接写云端 PG
                                                    ├─ 到点：问「完成了吗」→ 回完成 → 写 todo_daily_completions
                                                    └─ 群聊：watch_groups 静默入库（未启用）

课程群 ──旁听──> 同上（batch 抽取，未启用）

CloudBase PG（todo_tasks / todo_daily_completions / todo_reminder_*）
   └─ reminder-tick（每分钟）→ 企业微信群机器人（webhook）
   └─ 站点（Vite 静态托管）读写同一份数据
```

**核心决策：真相源在云端，不在 bot。** 理由：提醒必须 7×24，而 QQ 这条链路依赖
Windows + QQ 客户端 + 注入，是最脆弱的一环。bot 只是"入口"。

---

## 4. 文件地图

### 4.1 QQ / 插件：`D:\deepseekharness\qq\`

| 路径 | 作用 | 备注 |
|---|---|---|
| `README.md` | **系统总览** | 入口文档，先读这个 |
| `docs/HANDOFF.md` | 本文 | 现状 + 踩坑 + 下一步 |
| `astrbot_plugin_agenda/main.py` | 插件入口 | 私聊捕获在 `on_private_message`，确认写库在 `_confirm_pending`，追问循环在 `_followup_loop` |
| `astrbot_plugin_agenda/capture.py` | **私聊多条目** | 切分/编号/覆盖校验/补抽/草稿文案/选择解析 |
| `astrbot_plugin_agenda/followup.py` | **到点追问** | `due_rows` / `render_question` / `selection` |
| `astrbot_plugin_agenda/extractor.py` | 群聊两套 prompt | 群聊 `SYSTEM_PROMPT`；`parse_events` |
| `astrbot_plugin_agenda/cloud_writer.py` | 写云端 | `normalize()`、`write()` 查重、`complete()` 标记完成 |
| `astrbot_plugin_agenda/cloud_reader.py` | 云端只读 | `/任务`、每日简报、追问的数据源 |
| `astrbot_plugin_agenda/intent.py` | 对话意图 | 「每天 9 点提醒我」→ 每日简报时间 |
| `astrbot_plugin_agenda/store.py` | SQLite | `pending` / `catchup` / `followups` 等入口侧状态 |
| `astrbot_plugin_agenda/_conf_schema.json` | Dashboard 配置 | 含 `cloud_*` / `capture_*` / `followup_*` |
| `tests/` | 119 项单测 | `test_capture` / `test_followup` / `test_flow_private`（真实 handler） |
| `scripts/` | 运维脚本 | 启动、装插件、自检、`bench_capture.py`、`verify_complete.py` |
| `config/local-notes.md` | 本机凭据笔记 | gitignore |
| `astrbot/data/plugins/astrbot_plugin_agenda/` | 安装副本 | 由 `install-plugin.ps1` 复制，改了源码要重跑 |

### 4.2 站点 + 云函数：`D:\codex\project\日程安排\`

| 路径 | 作用 |
|---|---|
| `cloudfunctions/reminder-tick/core.js` | 投递内核：到点提醒 + 早报(`digest`) + 晚间(`digest_pm`) |
| `cloudfunctions/reminder-tick/index.js` | SCF 入口；dry-run 也分成 am/pm |
| `cloudfunctions/reminder-done/` | 提醒消息里的「标记完成」网页（token → RPC） |
| `cloudfunctions/register-friend/` | 朋友自助注册 |
| `cloudfunctions/agenda-ingest/` | 聊天写库 HTTP 入口（**未启用**，网关路由 403） |
| `cloudbase/migrations/20261116010000_reminder_countdown.sql` | 倒计时/晚间/逾期迁移（已应用） |
| `src/reminders.js` + `index.html` | 提醒设置表单（含提前天数、晚间时间） |
| `docs/提醒功能部署手册.md` | 状态、复核 SQL、验收步骤、已知限制 |

---

## 5. 云端现状（可直接查）

- 环境：`daily-todo-d3gq5mama7a468d02`，ap-shanghai，**体验版**（到期 2027-03-12）。
- 已应用迁移：…→ `20261105120000_reminders.sql` → `20261113001000_fix_ambiguous_completion_date.sql`
  → `20261116010000_reminder_countdown.sql`。
- 数据：`todo_tasks` 34 条（`deleted_at is null`），**0 条设了 `remind_time`**；
  `todo_reminder_settings` **1 行**（企业微信 `…eea6`，早报 08:00，晚间 20:30，提前 **7** 天）；
  `todo_reminder_log` 为空（测试记录已清理）。
- 函数：`reminder-tick` / `reminder-done` / `reminder-device` / `agenda-ingest` 均已部署。
- 路由：`/api/reminder/done`、`/api/reminder/device` 正常；`/api/agenda/ingest` 存在但返回 403。
- 日志服务（CLS）**未开通**，`tcb fn log` 会报 `topic not exist`——运行证据只能看
  `todo_reminder_log` 或手动 `tcb fn invoke`。

关键 SQL（改任何东西之前先看一眼）：

```sql
select count(*) as tasks from public.todo_tasks where deleted_at is null;
select right(wecom_webhook,4) as tail, to_char(digest_time,'HH24:MI') as am,
       to_char(evening_time,'HH24:MI') as pm, remind_lead_days
from public.todo_reminder_settings;
select kind, ref_id, channel, status,
       to_char(sent_at at time zone 'Asia/Shanghai','HH24:MI:SS') as sent
from public.todo_reminder_log order by claimed_at desc limit 10;
```

---

## 6. 常用命令

```powershell
# 登录（非交互，用环境 API Key；已登录则跳过）
$s = Get-Content (Join-Path $env:TEMP 'dsh-tcb-secrets.json') -Raw | ConvertFrom-Json
tcb login --cloudbase-api-key $s.apiKey -e $s.envId

# 执行 SQL（多语句可用，整份迁移可直接喂）
tcb db execute -e $s.envId --sql "select 1"
$sql = Get-Content 'cloudbase/migrations/xxx.sql' -Raw
tcb db execute -e $s.envId --sql $sql

# 部署
tcb fn deploy reminder-tick -e $s.envId --force
tcb hosting deploy dist -e $s.envId

# 触发器（deploy 不会自动建）
tcb fn trigger create reminder-tick -e $s.envId `
  --trigger-name reminder-every-minute --cron "0 */1 * * * * *"

# 手动跑一次看返回值
tcb fn invoke reminder-tick -e $s.envId
```

```powershell
# 测试
cd D:\codex\project\日程安排
npm run check; npm run test:reminder; npm run test:features; npm run test:optimizations
node --test tests/agenda-ingest.test.cjs

cd D:\deepseekharness\qq
python -m unittest discover -s tests -t . -v      # 119 项
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-plugin.ps1
```

---

## 7. 已验证 / 未验证

**已验证**

- 企业微信 webhook 真实送达（到点 + 早报两条，`sent`，attempts=1）。
- 迁移在真实 PostgreSQL 上执行过（本地起了一个真库，跑完整 11 份迁移 + 18 项断言：
  逾期天数、倒计时排序、`lead_days=0`、am/pm 账本不互抢、设置读写往返）。
- 插件云端写入：真库写入成功 → 再写一次返回 `duplicate` 同 id → 删除测试行 → 0 残留。
- 站点 UI：9 项浏览器测试（含新设置项往返、390/320px 不溢出）。
- **QQ 私聊全链路**（2026-11-16 13:49）：主号发「周五 23:59 交作业」→ 插件解析出
  2026-11-20 23:59（deadline）→ 回执草稿 → 回「1」→ 云端写库成功、草稿清空。
- **开机补拉**（2026-11-16 13:54）：把水位回拨到 13:49 前再启动，机器人主动发出
  「🔄 开机补拉：关机期间有 1 条像日程…」，回「1」后确认入库并提示"这条日程里已经有"。
- **一段话四件事**（2026-11-17 bench）：同一条培训通知 → 4 条，日期 11-17/12-01/11-20/11-25 全对。
- **标记完成**（2026-11-17）：真实云端插入 2026-01-01 完成行 → 读回 `completed=true` → 删除。

**未验证**

- 晚间 `digest_pm` 在生产触发（同代码路径单测覆盖，但没真实发过）。
- 群聊静默旁听（`watch_groups` 空）。
- 补拉的真实长间隔场景（本次用回拨水位模拟 1 条；没有真关机 12 小时）。
- 到点追问的「回完成 → 落库」只在集成测试里跑过，真实手机上还没回一次。

---

## 8. 未完成工作（按建议优先级）

### P1b 开机补拉（✅ 已完成 2026-11-16）

电脑一天只开几小时，关机期间收到的私聊不会补记。实现：

1. 插件启动后（等 OneBot 可达）用 `get_friend_msg_history`（`user_id` + `count`）
   拉最近一页私聊，按 `private_seen_ts` 水位过滤，只留主号发的消息；
2. 逐条走 `_capture`，解析出日程的进 `catchup` 表排队，然后**逐条问确认**，
   确认后才写云端（和在线私聊同一条链路，同样查重）；
3. 超过 `catchup_max_age_days`（默认 7 天）的只汇总条数，不逐条打扰；
4. 水位在每条私聊（含短消息）处理时前移；首次启用没有基线时以当前时间为基线，
   避免把历史聊天全问一遍。

配置项：`catchup_enabled` / `catchup_max_age_days` / `catchup_history_count`(200) /
`catchup_max_items`(20)。代码在 `catchup.py` + `store.py` 的 `catchup` 表 +
`main.py` 的 `_catchup_loop/_run_catchup/_advance_catchup`。

**已知限制**：只取一页（200 条），关机太久超出这一页的旧消息会丢；补拉前如果已经
有未答完的草稿，会等草稿处理完再自动接着问。

### P2 群聊旁听接通

- 插件 `watch_groups` 填 1–2 个**课程/班级通知群**（作业 DDL 的真正来源）；
- 同时把群号加进 AstrBot `id_whitelist`，否则插件收不到消息；
- 先观察一天抽取质量再开提醒。

**验收**：群里助教发"周五交实验报告" → 站点出现任务，且群里**没有任何回复**。

### P3 "还没完成"查询

- 云端加只读 RPC：逾期（单日任务、30 天内）/ 今天 / 未来 3 天；
- 机器人 `/日程` 改成读云端，而不是本地 SQLite；
- 早报已经带逾期与倒计时，先跑一周看够不够。

### P4 企业微信当入口（可选）

用户问过"能不能给企业微信装个 AI"，结论：**不划算**。企业微信群机器人只能发不能收；
要收支得自建应用 + 可信域名 + 加解密。真要就接 AstrBot 的 `wecom` 适配器，写库走同一条链路。

### P5 博客 / 服务器（用户已搁置）

结论已给：静态博客不需要服务器，CloudBase 静态托管零成本；等真需要 WordPress 再买 2C4G。
**不要主动重启这个话题。**

---

## 9. 已知坑（都踩过）

| 坑 | 现象 | 规避 |
|---|---|---|
| PowerShell 改 UTF-8 | 中文变乱码、路径坏掉 | 只用 read/edit/write 工具 |
| `tcb routes add` | `system internal domain ... not supported` | 内部域名不能手工建路由；用 `tcb fn deploy --path` 生成，或控制台操作 |
| `--path` 生成的路由 | 返回 **403**（网关默认开鉴权） | 控制台把该路由"鉴权"关掉即可；当前 bot 不走它 |
| `tcb fn deploy` | 不会建触发器 | 必须 `tcb fn trigger create` |
| `tcb fn deploy` 交互确认 | 非 TTY 下卡住 | 加 `--force` |
| CLS 日志未开 | `tcb fn log` 报 `topic not exist` | 看 `todo_reminder_log` 或 `tcb fn invoke` |
| 云函数目录没有 package.json | 被根 `"type":"module"` 当成 ESM，`require` 报错 | 每个函数目录放自己的 `package.json`（照 reminder-tick） |
| 站点 CDN 缓存 | 部署后页面还是旧的 | 用 `?v=时间戳` 访问验证；CDN 几分钟刷新 |
| 体验版限制 | 不能加本地域名白名单等 | 真登录测试走公网地址 |
| pgcrypto | 迁移里用了 `digest()`/`gen_random_bytes()`，缺扩展时**建函数不报错**、配对才 500 | 上线前 `select extname from pg_extension where extname='pgcrypto'` |
| 推理型模型 + 长 prompt | `finish_reason=length`、`content` 空串 | 分段 + 小 prompt 补抽（§12） |

---

## 10. 给接手窗口的建议动线

1. QQ 私聊 + 补拉 + 多条目 + 追问**都已经实测/上线**，不需要从头验证；先确认 bot 在跑：
   6185/6199/5099 三个端口、小号在线。
2. 读根目录 `README.md` 了解全貌，再读本文 §12/§13 了解最近两次改动。
3. 下一步做 **P2 群聊静默旁听**：`watch_groups` 填 1–2 个课程/通知群，群号同时加进
   AstrBot 的 `id_whitelist`，先观察抽取质量再开提醒。一次只引入一个变量。
4. 再往后是 P3「我最近有什么没完成」。
5. 每改一次插件记得重跑 `install-plugin.ps1` 和 119 项单测；改完要重启 AstrBot
   才会加载新代码（插件没有热重载）。
6. 日常启动仍用 `Start-All.cmd`。

---

## 11. 一句话交接

**入口的拼图（私聊实测 + 开机补拉 + 多条目 + 到点追问）都补上了，云端提醒和站点本来就是通的。
下一步是 P2 群旁听。别碰服务器和博客，别把真相源挪回 bot 本地。**

---

## 12. 私聊"一段话多件事"漏抽修复（11-16 17:00，已上线）

**症状**：用户发了一条 4 场党课培训的通知，bot 只认了第 1 场。原文在
`catchup` 表 id=2（`raw_text`），解析结果只有 11-17 那一条。

**根因（三条，都不是"模型笨"）**：

1. **schema 只能装一条**：旧 prompt 写的是"用户会用一句话告诉你一件要做的事"，
   输出是 `{"item": {...}}` 单对象，`pending` 也只存一条。模型看懂 4 条也没地方放。
   实测 deepseek-flash 的思考里原话："We can only output one item? The schema…"。
2. **推理型模型 + 长 prompt = 空回复**：同一条消息 `finish_reason=length`，
   `reasoning_tokens` 吃满 1500，`content` 返回空串。
3. **空回复被静默吞掉**：旧 `_capture` 捕获异常后返回 `None`，`on_private_message`
   直接 `return`，事件继续流向普通聊天——用户看到一句闲聊回复，以为记下了。

**改法**（新增 `capture.py`，改 `main.py`）：

- 切分不交给模型：按空行/列表项切块，带日期或时刻的块编号 `[S1]..[Sn]`，
  prompt 里"每段必须有一条结果"；
- **覆盖校验**：`missing_segments()` 算出哪几段没答，换成"只问这几段"的小 prompt 补抽
  （最多 2 轮，每批 ≤4 段）——顺带绕开了推理模型被长 prompt 拖死的问题；
- **闲聊/日程双保险**：模型给 `kind`，代码用"有没有带时间的段落"兜底；纯吐槽的段模型回
  `skip`，不算漏；像任务但没日期就反问"哪天"，不再静默放行；
- **多条目草稿**：一次列出 N 条，回 `1` 全存、`1 3` 只存这两条、`2` 全不要、`重试` 重解析；
- 配置新增 `capture_provider_id` / `capture_repair` / `capture_max_segments`。

**实测**（同一台机、同一个 deepseek-flash）：4 场通知 → 4/4 条；一句话三件事 → 3 条；
日程+闲聊混写 → 只抽 2 条；纯闲聊 → `kind=chat` 放行。

---

## 13. 到点追问「完成了吗」（11-16 17:12，已上线）

**要什么**：任务过了自己的时间还没完成，机器人来问一句；确认完成后自动去标记完成。

**完成状态怎么存（关键）**：站点把"完成"记在 `todo_daily_completions`
（主键 `owner_id + task_id + completion_date`，`completed = true`），
`todo_completion_history` 由数据库触发器维护。所以"标记完成"= 往这张表 upsert，
bot 打勾和网页勾选是同一件事，不需要第二个状态字段。

**实现**：`followup.py`（纯逻辑）+ `CloudWriter.complete()`（PostgREST upsert，
`?on_conflict=...` + `Prefer: resolution=merge-duplicates`）+ `main.py` 的 `_followup_loop`。

- 每 `followup_check_sec`（默认 300）读一次云端 `overview(days=0)`；
- 过了任务时间 + `followup_grace_min`（15）还没完成 → 一次问一批（最多
  `followup_max_items`，默认 6，编号列出）；`(task_id, day)` 记进 `followups` 表，
  同一天不再问第二次；关机太久（>12h）不追；
- 回复解析在 `followup.selection()`：`完成` / `1 3` / `没做`，写库成功才把追问标 `done`，
  失败保持 `asked` 让用户回「完成」重试；发送失败会删掉占位记录，下一轮重发；
- 有未答完的草稿、或上一批追问还没回答时，不重复打扰。

**验收**：真实云端做过一次"插入 2026-01-01 的完成行 → 读回 `completed=true` → 删除"
（`scripts/verify_complete.py`，不留脏数据）；重启后 17:09:59 真实问出「交实验报告 /
去代课」两项，`followups` 两行 `asked`；119 项单测通过，其中
`tests/test_followup.py` 覆盖时间判定/文案/回复解析，
`tests/test_flow_private.py` 覆盖"回完成→调用 complete→落库→追问关闭"整条链路。

**已知边界**：只追问"今天"的任务（含跨零点 12 小时内的昨日项），更早的逾期只在早报里列；
问过一次就不再问，用户当天忘了回就等下次手动勾。

---

## 14. 仓库整理（11-17）

- 删除 `vendor/astrbot`（24 MB，AstrBot 源码克隆，仅作 API 参考；需要时
  `git clone https://github.com/AstrBotDevs/AstrBot.git vendor/astrbot` 即可恢复）；
- 删除 `astrbot/data/temp/*`（44 MB QQ 图片/表情缓存，运行时会重建）；
- 删除根目录早期残留的 `data/`（11-13 误建的 AstrBot 数据目录）与一次性诊断产物
  `acl-reports/`；清掉所有 `__pycache__` 与旧 `startup*.log`；
- `plan.md`、`master_lntano_read_me_please.md` 归档进 `docs/archive/`；
  `HANDOFF-20261116.md` 移到 `docs/HANDOFF.md`，系统总览另写进 `bot/README.md`。

**合并进站点仓库（11-17 01:00）**：整个机器人目录搬进 `D:\codex\project\日程安排\bot\`，
和网站同一个 git 仓（`lntanovo/daily-todo`）——数据契约（`cloudbase/migrations/`）在那边，
分仓迟早版本漂移。入库的只有 44 个文件 / 0.35 MB：

- 源码：`astrbot_plugin_agenda/`、`tests/`、`scripts/`、`config/*.example.*`、3 个启动脚本；
- 文档：`README.md`（系统总览）、`docs/HANDOFF.md`（本文）；
- 挡在库外的：`astrbot/`（运行数据，含 CloudBase Key）、`tools/snowluma/`（177 MB 第三方）、
  `.uv/`、`config/local-notes.md`、`config/persona.xiaosha.md`（含真实 QQ）、`docs/archive/`。

旧目录 `D:\deepseekharness\qq\` 只留了一个 `MOVED.md` 指路，可以删。以后在 `bot/` 里改代码，
脚本相对路径不变（`install-plugin.ps1` 仍然往 `bot/astrbot/data/plugins` 拷）。

提交前做过脱敏：测试 fixture 的 QQ 号换成 `10001` / `99999`，HANDOFF 里的小号号码去掉，
本机绝对路径在开头加了一句说明。
