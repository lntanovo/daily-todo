# 今天算数 · Make Today Count

**每天打开就能用的日程页：任务在云端，提醒到企业微信，QQ 里说一句话也能记下来。**
**A daily agenda I actually use every day: tasks in the cloud, reminders in WeCom, and a QQ bot that takes tasks from chat.**

**中文** · [English](#english)

- **网站**：单日 / 连续多日 / 重复任务，完成打勾与历史，专注计时，365 天热力图，ZIP 完整备份；暖纸主题，登录后按账号隔离。
- **提醒**：云函数每分钟跑一次——到点提醒、早报（逾期 + 倒计时）、晚间收尾，推到企业微信；**不依赖任何一台常开的电脑**。
- **QQ 入口（可选）**：`bot/` 里的 AstrBot 插件。私聊发一句话或一整段通知都能拆成任务，先回执确认再写入；任务过了时间会问你「完成了吗」，回「完成」自动打勾。

> 当前公网版本：**v1.5.1** —— 提醒增强已上线（到点提醒、每日早报、晚间收尾、提前 N 天倒计时，推送到企业微信）。
> 五项优化的真实账号 / 双账号验收仍待完成，详见 `docs/五项优化验收记录.md` 与 `docs/提醒功能部署手册.md`。

网站部分必须通过 Vite 打开（`npm run dev`），不再支持双击 `index.html`；数据存在 CloudBase PostgreSQL，每个账号只能访问自己的数据。

## 用开发方式打开

在 VS Code 中打开本文件夹，然后打开终端，第一次运行：

```powershell
npm install
```

以后每次运行：

```powershell
npm run dev
```

终端会显示一个本地地址，一般是 `http://127.0.0.1:5173/`。保持终端窗口运行，浏览器打开这个地址；按 `Ctrl+C` 停止。当前试用套餐不能新增本地域名白名单，因此真实登录和云端数据测试请使用下面的公网地址。

生成可上传到网站的文件：

```powershell
npm run build
```

成功后会出现 `dist` 文件夹。云端部署上传的是这里面的成品，而不是 `node_modules`。

## 使用说明

- 日程页可快速录入事项，也可在右上角打开完整表单；单日事项选择一个日期，共同任务选择开始和结束日期（包含首尾两天）。
- 登录后可从顶部切换“日程 / 专注 / 个人”，地址栏与浏览器前进后退会同步当前视图。
- 日程页可粘贴编号任务或读取 Markdown / Word 文件，预览后批量创建；也可按当前日期、日期范围或全部任务导出 Markdown / Word。
- 点击圆圈完成或取消完成；共同任务的其他日期不受影响。
- 编辑共同任务会修改整条任务；保留日期范围内的完成记录。更换任务类型或移动单日日期会重置完成状态。
- 任务支持每日、每周指定星期和每月指定日期重复。重复任务按日期独立完成，月末不存在的日期会跳过。
- 删除任务会移入“最近删除”，可立即撤销或跨设备恢复；原有补充和完成记录会保留。
- 可把已有任务保存为账号专属模板，并快速套用、改名或删除模板。
- 页面固定使用暖色纸张主题；首页显示今天的公历、农历和星期，查看其他日期时另行提示当前清单日期。
- 日历按钮可以直接切换年份、月份和日期；黑点表示当天有事项。
- 首页短句可在中二、抽象、名言和混合模式之间切换；内置 30 多句可直接选择，也可保存自己的句子。同一天刷新和任务重绘不会无故换句。
- 设置按钮固定在左下角，抽屉从右侧展开，集中账号、外观、陪伴、句子和旧数据导入操作。
- 番茄钟使用独立“专注”页，支持任务关联、暂停、继续、提前结束、手动休息、迷你计时器及最近七天统计；专注会话按账号云端同步，旧本机记录可预览迁移。
- “个人”页展示近 365 天云端任务完成热力图、连续完成天数和按日明细；完成历史由云端快照表保留并按账号隔离。
- 每条事项下方可以添加最多 500 字的“当日补充”。同一任务每天的补充互相独立，完成任务不会删除补充。
- 任务标题使用思源宋体，补充说明使用霞鹜文楷；字体随网站一起提供，无需用户安装。
- `背景 / BACKGROUND` 可恢复原色暖纸，也可上传 JPG、PNG、WebP、GIF。大尺寸静态图片会在浏览器中缩小并压缩，原图不被修改；GIF 和动态 WebP 保留动画。
- 个人页可下载包含任务、重复规则、完成历史、补充、专注、模板、外观偏好和私有背景的 ZIP 完整备份；导入时先校验与预览，再按类别合并。Markdown/Word 清单只是可阅读导出，不是完整备份。
- 登录后像素宠物默认出现在右下角；图标放大 1.5 倍，可用鼠标或触屏拖动，位置会保存在当前浏览器。点击它会做动作并随机回应。花瓣缓慢飘落，完成任务时集中出现。工具栏的 `动效 / MOTION` 可以关闭并记住选择。
- 事项可选「提醒时间」和提醒开关；留空则沿用每日开始时间。到点后由云端定时器推送到飞书 / 企业微信，消息里的「标记完成」按钮可直接勾选。设置抽屉的「提醒」区配置 Webhook、早报时间、宽限、免打扰、**提前几天开始倒计时**与**晚间收尾时间**；Webhook 保存在服务端，页面只显示末尾四位。倒计时、逾期与「今天还没做完」折进早报和晚间两次汇总，不单独逐条推送，避免一条作业连轰好几天。连续多日任务只进汇总，避免连续多周轰炸。部署与验收步骤见 `docs/提醒功能部署手册.md`。

登录后，事项保存到 CloudBase PostgreSQL，每个账号只能访问自己的数据。如果浏览器中还有旧版本机事项，登录后会显示一次性导入入口；导入不会删除本机备份。

登录页下方的 `注册 / SIGN UP` 是统一入口，也可以直接分享 <https://daily-todo-d3gq5mama7a468d02-1485775300.tcloudbaseapp.com/#join>。朋友填写称呼、与 lntano 的关系，并自己设置一个 5–24 位的账号和密码。注册不使用手机短信，密码不会写进日程数据库或浏览器存储。当前云端开关为开启，每天最多 20 个、累计最多 100 个账号；注册接口还按客户端 IP 限制为每秒 1 次。网络中断时应在原页面使用原信息重试，系统会返回同一个账号，不会重复创建。

## 可选：QQ 机器人入口（`bot/`）

`bot/` 是一个 AstrBot 插件 + 运行脚本，把「随手记日程」搬到 QQ 私聊里，写的是**同一份** `todo_tasks` / `todo_daily_completions`：

- 一句话或一整段通知都行（四场培训的截图式通知能拆成四条），先回执确认再落库；
- 任务过了自己的时间还没勾，私聊问一句「完成了吗」，回「完成」直接写完成表，和网页打勾同源；
- 每日简报、开机补拉漏掉的私聊、群聊静默旁听（默认关）。

它是**可选组件**：需要 Windows + 一直挂着的 QQ 客户端（SnowLuma 注入式协议端），不装也不影响网站和云端提醒。架构、配置项和已知边界见 [`bot/README.md`](bot/README.md)，实现取舍和踩坑见 [`bot/docs/HANDOFF.md`](bot/docs/HANDOFF.md)。

## 网站化进度

- CloudBase 环境：`daily-todo-d3gq5mama7a468d02`（上海）。
- 当前公网地址：<https://daily-todo-d3gq5mama7a468d02-1485775300.tcloudbaseapp.com/>。
- 已开启用户名密码登录，Publishable Key 仅保存在被 Git 忽略的 `.env.local`。
- PG 任务、完成、历史、补充、重复规则、专注与模板等表已启用账号级 RLS；数据库迁移版本见 `docs/五项优化验收记录.md`。
- 公网版已实现登录、退出、云端 CRUD 和本机事项迁移；静态文件、首页和错误页配置已于 2026-09-14 验证成功。
- 2026-09-14 登录页更新为 `MAKE TODAY COUNT / 让今天算数`，加入固定密码显隐按钮与 `made by lntano` 署名。
- 2026-09-15 增加 `注册 / SIGN UP`：云函数自动创建 CloudBase 外部用户；私有注册记录启用 RLS 并仅允许服务端访问；统一入口支持注册开关、每日 20 人、累计 100 人和重复提交保护。
- 2026-09-16 发布 v1.1：只保留 Warm Paper；注册账号由用户自行设置；任务可选每日起止时间，并增加红色紧急、蓝色普通优先级。
- 2026-09-16 发布 v1.2：加入放大 1.5 倍且可点击、可拖动、可记忆位置的像素宠物，低密度暖色花瓣、任务完成庆祝和可持久化的动效开关；参考项目及 MIT 许可证见 `THIRD_PARTY_NOTICES.md`。
- 2026-09-19 发布 v1.3：新增任务每日补充、年月日快速日历、个人私有背景上传，以及思源宋体任务标题与霞鹜文楷补充说明；静态背景自动压缩，GIF 与动态 WebP 保留动画。
- 2026-09-19 发布 v1.3.1：将背景暖灰遮罩由 78% 调低至 58%，让用户图片的色彩和细节更清晰，同时保留文字可读性。
- 2026-09-22 发布 v1.3.2：页头改为正体 `to do list`，修复副标题换行重叠；背景遮罩降至 40%，文字直接显示在图片上，不添加白色底块。图片背景上的文字加深、小标签加大加粗，并增加细浅色描边，提高复杂背景上的辨识度。
- 2026-09-22 发布 v1.3.3：品牌统一为大写 `TO DO LIST`，番茄钟移到品牌右侧，设置入口固定在左下角并从右侧展开；首页日期更醒目，短句区缩小并支持 30 多句直选及最多 80 字的自定义内容。专注记录仍按账号保存在当前浏览器，不包含云端迁移。
- 2026-09-27 发布 v1.3.4：新增三视图导航、编号文本 / Markdown / Word 导入预览、Markdown / Word 导出、独立专注页和个人完成热力图；应用 `20260927120000_completion_history.sql` 并回填既有完成记录。自定义背景下的主要面板改为透明，热力图改用 GitHub 绿色层级，同时移除全部白色文字描边。
- 2026-10-08 发布 v1.4.0：五项优化、数据库迁移和完整备份格式已完成并上传到现有 CloudBase 静态托管；公网未登录页的客户端初始化与资源检查通过，真实账号功能及双账号隔离仍待验证。
- 自动验收已确认公网首页与 SDK 脚本均返回 HTTP 200，并使用本机 Edge 通过腾讯云风险提示页后验证登录页渲染和显隐交互；真实账号登录和两账号隔离仍需由用户输入测试密码完成。
- 2026-11-16 提醒增强（已应用迁移并重新部署 `reminder-tick`，每分钟触发器已创建；企业微信通道已实测送达）：新增 `remind_lead_days` / `evening_enabled` / `evening_time`，早报增加「逾期」与「未来 N 天倒计时」两个区块，新增 20:30 晚间收尾（独立账本 `digest_pm`）。迁移 `cloudbase/migrations/20261116010000_reminder_countdown.sql`，部署与验收步骤见 `docs/提醒功能部署手册.md`。
- 腾讯云默认测试域名首次访问可能显示“风险提醒”，点击“确定访问”即可进入；这是默认域名的平台规则，不是本站错误。

## 工程检查

```powershell
npm run check
npm run test:registration
npm run test:reminder
npm run test:focus
npm run test:transfer
npm run test:features
npm run test:optimizations
npm run build
```

## 验证记录

2026-09-10 使用本机 Edge 的隔离测试会话完成；测试数据没有写入日常浏览器。2026-09-12 增加网站构建流程、网站化说明、项目检查和本地保存状态标识。2026-09-14 使用本机 Edge 验证登录页在 1440 / 320px 下无溢出，密码显示与隐藏正常。2026-09-15 使用隔离 Edge 会话跑通注册、自动账号登录、新增云端事项、刷新保留与退出。

- 单日增删改、完成/取消完成、空日期校验、刷新保存。
- 共同任务包含起止日，范围外隐藏；跨周显示、每日独立完成、范围编辑、整条删除。
- 上下周、回到今天、跨年、闰日。
- 暖色主题、红蓝优先级、每日时间段、可点击和拖动并保存位置的像素宠物、花瓣庆祝、动效开关、键盘焦点、44px 完成按钮和减少动效偏好。
- 1440 / 1024 / 720 / 390 / 320px 窗口宽度下的长文字与弹窗无横向溢出。
- 存储读写失败显示提示；保存失败保留输入，部分写失败尝试回退。
- 遇到损坏的任务集合，保留原始存储，显示可读取事项并暂停事项写入，避免覆盖待恢复的数据。
- 测试过程中未捕获页面 JavaScript 异常或控制台错误。

截图见 `docs/screenshots/`（示例事项，仅供视觉参考）；历史版本的文档已归档到 `docs/archive/`。

---

## English

**Make Today Count** — a small, self-hosted agenda that I actually use daily.

| Piece | What it does | Where it runs |
|---|---|---|
| Web app (Vite + CloudBase) | Tasks as single day / multi-day range / recurring, tick-off with per-day history, focus timer, 365-day heatmap, ZIP backup & restore | CloudBase static hosting |
| Reminder engine (`reminder-tick`) | Every minute: due reminders, 08:00 digest (overdue + countdown), 20:30 evening wrap-up → WeCom / Feishu webhook | Cloud function + cron trigger |
| QQ bot (`bot/`, optional) | Say one sentence — or paste a whole notice — in QQ to record tasks; it asks "done?" once a task's time has passed and ticks it off when you reply | Your own Windows machine, with QQ running |

**Design note.** The database is the single source of truth. Reminders must run 24/7, so they live in the cloud; the QQ bot is just an entry point and is allowed to go offline with your PC.

**Run it**

```powershell
npm install
npm run dev        # http://127.0.0.1:5173
npm run check      # static project checks (41 key entry points)
npm run build      # produces dist/ for CloudBase static hosting
```

Backend setup — CloudBase environment, PostgreSQL migrations, WeCom webhook, cron trigger — is documented in `docs/提醒功能部署手册.md` (Chinese) and `cloudbase/migrations/`.

**QQ bot (optional).** See [`bot/README.md`](bot/README.md). Needs Windows, a logged-in QQ client (SnowLuma is an injector), and AstrBot. Its 119 unit tests run offline:

```powershell
cd bot
python -m unittest discover -s tests -t .
```

**Stack.** Vanilla JS (no framework) + Vite, CloudBase PostgreSQL with row-level security, Node.js cloud functions, and a Python plugin for AstrBot.

**Credits.** Fonts and the pixel-pet reference project are credited in `THIRD_PARTY_NOTICES.md`.
