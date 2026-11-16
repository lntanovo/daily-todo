# 自建部署指南

想在自己的 CloudBase 环境里跑一份？按这个顺序做。文中所有密钥都是占位符，
**不要把自己的 Key 提交进仓库**（`.env.local`、`cloudbaserc.json`、`config/local-notes.md` 都已被 gitignore）。

> 作者自己的部署与验收记录在 `docs/提醒功能部署手册.md`，那是"我这台机器"的流水账；
> 本文是可复用的通用步骤。

## 0. 准备

| 需要 | 说明 |
|---|---|
| 腾讯云 CloudBase 环境 | 体验版够用；需要**开启 PostgreSQL** 和**静态网站托管** |
| Node.js 20+ / npm | 构建前端 |
| CloudBase CLI | `npm i -g @cloudbase/cli`，然后 `tcb login` |
| 企业微信群机器人 / 飞书机器人 | 提醒的出口，任选其一（可以后面再配） |

```powershell
git clone https://github.com/lntanovo/daily-todo.git
cd daily-todo
npm install
```

## 1. 建环境

控制台新建环境后记下 `envId`（形如 `daily-todo-xxxx`），然后：

- **数据库 → PostgreSQL → 初始化**（建库后才有 `public` schema）
- **静态网站托管 → 开启**
- **云开发网关（HTTP 访问服务）→ 开启**，后面三条例由它转发

## 2. 跑数据库迁移

迁移按文件名顺序执行，本应用是这 11 份：

```
20260914143748_create_todo_tables.sql          任务 / 完成 / RLS
20260915190000_friend_registration.sql         注册台账与限额
20260916100000_task_schedule_username.sql      优先级、起止时间、自选用户名
20260918160000_daily_notes_background.sql      每日补充、外观偏好、私有背景桶
20260927120000_completion_history.sql          完成历史快照 + 触发器 + 回填
20261008090000_five_optimizations.sql          recurring / 软删除 / 专注 / 模板
20261008093000_atomic_backup_restore.sql       单事务恢复 RPC
20261008094000_restore_rpc_permission.sql      收回 anon 的执行权限
20261105120000_reminders.sql                   提醒设置、投递账本、完成令牌
20261113001000_fix_ambiguous_completion_date.sql
20261116010000_reminder_countdown.sql          倒计时 / 晚间收尾 / digest_pm
```

```powershell
foreach ($f in Get-ChildItem cloudbase/migrations/*.sql | Sort-Object Name) {
  if ($f.Name -like '2026101*_foodlog_*' -or $f.Name -like '20261104000000_foodlog_*') { continue }
  tcb db execute -e <envId> --sql (Get-Content $f.FullName -Raw)
}
```

> `foodlog_*` 那 3 份是作者另一个应用（FoodLog）的表，只是共用同一个数据库。
> 你自己部署的话**跳过它们**。

## 3. 生成部署配置

`cloudbaserc.json` 存着服务端 Key，不入库，由脚本生成。它读取
`%TEMP%\dsh-tcb-secrets.json`（Windows 的临时目录；脚本第 10 行是路径，换系统要改）：

```json
{
  "envId": "<你的环境 ID>",
  "apiKey": "<CloudBase 服务端 API Key>",
  "region": "ap-shanghai",
  "agendaOwnerId": "<站点账号 uid，可选>",
  "agendaBotSecret": "<随机串，可选>"
}
```

```powershell
node tools/make-cloudbaserc.cjs
```

⚠️ **两处要按你的环境改**：脚本里 `gatewayBase` / `siteUrl` 写死了 `-1485775300` 域名后缀。
换成你自己的（控制台「云开发网关」里能看到实际域名），否则提醒消息里的"标记完成"链接会 404。

## 4. 部署云函数

```powershell
tcb fn deploy reminder-tick  -e <envId> --force
tcb fn deploy reminder-done  -e <envId> --force
tcb fn deploy reminder-device -e <envId> --force
# 注册函数不在 cloudbaserc 里，单独部署：
tcb fn deploy register-friend -e <envId> --force
```

**触发器不会随 deploy 创建**，必须单独建，否则 `reminder-tick` 只是个躺着的函数：

```powershell
tcb fn trigger create reminder-tick -e <envId> `
  --trigger-name reminder-every-minute --cron "0 */1 * * * * *"
```

## 5. 部署前端

```powershell
# .env.local（gitignore）
#   VITE_CLOUDBASE_ENV=<envId>
#   VITE_CLOUDBASE_REGION=ap-shanghai
#   VITE_CLOUDBASE_ACCESS_KEY=<Publishable Key>

npm run check
npm run build
tcb hosting deploy dist -e <envId>
```

`Publishable Key` 是浏览器端用的公开 Key（不是服务端 Key），在控制台「环境 → 访问密钥」里。

## 6. 配提醒

登录站点 → 左下角设置 → **提醒**：填企业微信（或飞书）Webhook、早报时间、宽限、免打扰、
提前几天倒计时、晚间收尾时间 → 保存。

然后验证：

```powershell
tcb fn invoke reminder-tick -e <envId>     # 看 dry_run 还是真实投递
```

再查一次账本，确认没有卡在 `claimed`：

```sql
select kind, channel, status, to_char(sent_at at time zone 'Asia/Shanghai','HH24:MI:SS')
from todo_reminder_log order by claimed_at desc limit 10;
```

## 7. 验收清单

- [ ] 建一条今天到点的任务，等 1 分钟，企业微信收到消息
- [ ] 消息里点「标记完成」，网页显示已完成
- [ ] 早报时间到，收到「逾期 + 今天 + 倒计时」
- [ ] 晚间时间到，收到「今天还没做完」
- [ ] 同一条任务不会重复推送（`todo_reminder_log` 里每个 `kind + ref_id + date` 只有一行 `sent`）

## 8. 可选：QQ 机器人

见 [`bot/README.md`](../bot/README.md)。需要 Windows、登录着的 QQ 客户端和 AstrBot；
它写的是同一套 `todo_tasks` / `todo_daily_completions`，不装也不影响网站和提醒。

## 9. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 路由返回 **403** | 网关路由默认开鉴权 | 控制台把该路由的"鉴权"关掉 |
| 提醒一条都不发，也不报错 | 触发器没建 | `tcb fn trigger create` |
| 部署后页面还是旧的 | CDN 缓存 | 用 `?v=时间戳` 访问验证，等几分钟 |
| 建函数报 `digest()` 不存在 | 缺 pgcrypto | `select extname from pg_extension`，没有就 `create extension pgcrypto` |
| 完成链接 404 | `REMINDER_BASE_URL` 域名不对 | 用网关域名，不是静态托管域名 |
| 体验版报"不支持该操作" | 套餐限制（如本地域名白名单） | 用公网域名测试 |

## 许可

MIT，见 [LICENSE](../LICENSE)。字体与像素猫参考项目的授权见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
