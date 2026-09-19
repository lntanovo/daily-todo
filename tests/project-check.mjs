import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

const required = [
  ["页面标题", /<title>Today \/ 今日待办<\/title>/],
  ["周导航", /id="days"/],
  ["任务清单", /id="taskList"/],
  ["新增按钮", /id="addButton"/],
  ["暖色单主题", /Warm Paper only/],
  ["登录表单", /id="loginForm"/],
  ["同尺寸注册入口", /id="openRegisterButton"[^>]*>注册 \/ SIGN UP/],
  ["注册表单", /id="registerForm"/],
  ["自定义注册账号", /id="registerUsername"/],
  ["注册成功账号", /id="generatedAccount"/],
  ["登录页品牌标题", /MAKE TODAY[\s\S]*COUNT[\s\S]*让今天算数/],
  ["作者署名", /made by lntano/],
  ["固定密码显隐按钮", /id="passwordToggle"/],
  ["密码显隐交互", /function setPasswordVisibility\(visible\)/],
  ["用户名密码登录", /signInWithPassword\(\{ username, password \}\)/],
  ["真实会话检查", /auth\.getSession\(\)/],
  ["拒绝匿名会话", /user\?\.is_anonymous/],
  ["CloudBase PostgreSQL", /cloudApp\.rdb\(\)/],
  ["云端任务表", /todo_tasks/],
  ["云端完成记录表", /todo_daily_completions/],
  ["任务优先级", /name="taskPriority"[\s\S]*value="urgent"/],
  ["任务每日时间段", /id="taskStartTime"[\s\S]*id="taskEndTime"/],
  ["动效开关", /id="motionButton"[^>]*aria-pressed="true"/],
  ["日历入口", /id="calendarButton"/],
  ["个人背景入口", /id="backgroundButton"/],
  ["本机数据迁移", /id="migrateButton"/],
  ["本地任务存储键", /daily-todo\.tasks\.v1/],
  ["本地完成记录键", /daily-todo\.dailyCompletions\.v1/],
];

const registration = await readFile(new URL("../src/registration.js", import.meta.url), "utf8");
const registerFunction = await readFile(new URL("../cloudfunctions/register-friend/index.js", import.meta.url), "utf8");
const companion = await readFile(new URL("../src/companion.js", import.meta.url), "utf8");
const companionCss = await readFile(new URL("../src/companion.css", import.meta.url), "utf8");
const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const notes = await readFile(new URL("../src/daily-notes.js", import.meta.url), "utf8");
const appearance = await readFile(new URL("../src/appearance.js", import.meta.url), "utf8");
const featureCss = await readFile(new URL("../src/features.css", import.meta.url), "utf8");
const migration = await readFile(new URL("../cloudbase/migrations/20260918160000_daily_notes_background.sql", import.meta.url), "utf8");

const failures = required.filter(([, pattern]) => !pattern.test(html));
if (failures.length) {
  console.error(`项目检查失败：${failures.map(([name]) => name).join("、")}`);
  process.exit(1);
}

if (/<script[^>]+src=["']http:/i.test(html)) {
  console.error("项目检查失败：发现不安全的 HTTP 脚本引用。");
  process.exit(1);
}

if (/getLoginState\(|signInAnonymously\(|app\.database\(/.test(html)) {
  console.error("项目检查失败：发现旧版登录、匿名降级或 NoSQL API。");
  process.exit(1);
}

if (/data-theme=|id="themeButton"|Dark Editorial/.test(html)) {
  console.error("项目检查失败：冷色主题或主题切换入口仍然存在。");
  process.exit(1);
}

if (/One account, every device|待办事项将在登录后保存到你自己的云端空间/.test(html)) {
  console.error("项目检查失败：登录页仍包含已删除的说明文字。");
  process.exit(1);
}

if (!/\/api\/register/.test(registration) || !/externalUser/.test(registerFunction)) {
  console.error("项目检查失败：注册页面没有连接到云端外部用户创建流程。");
  process.exit(1);
}

if (/CLOUDBASE_API_KEY|TENCENTCLOUD_SECRET/.test(registration)) {
  console.error("项目检查失败：浏览器注册代码中出现了服务端凭证字段。");
  process.exit(1);
}

if (!/oneko\.gif/.test(companion) || !/celebrate/.test(companion) || !/MOTION_KEY/.test(companion)) {
  console.error("项目检查失败：宠物、完成庆祝或动效偏好没有正确接入。");
  process.exit(1);
}

if (!/textContent=text/.test(notes) || !/maxlength="500"/.test(notes) || !/note_date/.test(notes)) {
  console.error("项目检查失败：按天补充或纯文本显示没有完整接入。");
  process.exit(1);
}

if (!/app\.storage\.from\('todo-backgrounds'\)/.test(appearance) || !/createSignedUrl/.test(appearance)) {
  console.error("项目检查失败：个人背景未使用 CloudBase PG Storage v3。");
  process.exit(1);
}

if (!/Source Han Serif/.test(featureCss) || !/LXGW WenKai/.test(featureCss)) {
  console.error("项目检查失败：指定字体没有接入。");
  process.exit(1);
}

if (!/CREATE TABLE public\.todo_daily_notes/.test(migration) || !/ALTER TABLE storage\.objects ENABLE ROW LEVEL SECURITY/.test(migration) || !/CREATE POLICY todo_backgrounds_insert/.test(migration)) {
  console.error("项目检查失败：补充或背景的云端表与 RLS 迁移不完整。");
  process.exit(1);
}

if (!/addEventListener\("pointerdown", startDrag\)/.test(companion) || !/setPointerCapture/.test(companion) || !/PET_POSITION_KEY/.test(companion)) {
  console.error("项目检查失败：宠物拖动或位置保存逻辑不完整。");
  process.exit(1);
}

if (!/\.companion-pet\s*\{[^}]*width:\s*84px;[^}]*height:\s*84px;/s.test(companionCss) || !/scale\(2\.13\)/.test(companionCss) || !/touch-action:\s*none/.test(companionCss)) {
  console.error("项目检查失败：宠物 1.5 倍尺寸或拖动样式缺失。");
  process.exit(1);
}

if (!/adryd325\/oneko\.js/.test(notices) || !/jhammann\/sakura/.test(notices) || !/MIT License/.test(notices)) {
  console.error("项目检查失败：开源来源或许可证说明不完整。");
  process.exit(1);
}

console.log(`项目检查通过：${required.length} 个关键入口均存在。`);
