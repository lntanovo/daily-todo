"use strict";

/**
 * Generate cloudbaserc.json for deployment. Contains server-side secrets;
 * the output file is gitignored. Run: node tools/make-cloudbaserc.cjs
 */
const fs = require("fs");
const path = require("path");

const secretsPath = path.join(process.env.TEMP, "dsh-tcb-secrets.json");
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));

const envId = secrets.envId;
const apiKey = secrets.apiKey;

// Completion links must use the gateway domain: /api/reminder/done only has a
// route on the gateway host, not on the static hosting host.
const gatewayBase = `https://${envId}-1485775300.ap-shanghai.app.tcloudbase.com`;
// 静态站点域名与网关域名不同：回复里给用户点的链接必须是站点。
const siteUrl = `https://${envId}-1485775300.tcloudbaseapp.com`;

const baseEnv = {
  APP_ENV_ID: envId,
  APP_REGION: secrets.region || "ap-shanghai",
  CLOUDBASE_API_KEY: apiKey
};

const config = {
  envId,
  region: secrets.region || "ap-shanghai",
  functionRoot: "./cloudfunctions",
  functions: [
    {
      name: "reminder-device",
      timeout: 20,
      memorySize: 256,
      runtime: "Nodejs18.15",
      installDependency: false,
      description: "Desktop reminder device endpoints: pair/feed/ack/complete",
      envVariables: { ...baseEnv }
    },
    {
      name: "reminder-tick",
      timeout: 60,
      memorySize: 256,
      runtime: "Nodejs18.15",
      installDependency: false,
      description: "Minute-by-minute reminder delivery and daily digest",
      // 没有这条触发器，reminder-tick 只是个躺着的函数：reminder_*_batch 永远不会被调用。
      // SCF 七段 cron：秒 分 时 日 月 周 年。
      triggers: [
        { name: "reminder-every-minute", type: "timer", config: "0 */1 * * * * *" }
      ],
      envVariables: {
        ...baseEnv,
        REMINDER_BASE_URL: gatewayBase,
        REMINDER_DRY_RUN: "0",
        REMINDER_DIGEST_GRACE_MINUTES: "180",
        REMINDER_PURGE_DAYS: "60"
      }
    },
    {
      name: "reminder-done",
      timeout: 20,
      memorySize: 256,
      runtime: "Nodejs18.15",
      installDependency: false,
      description: "One-click completion landing page for reminder links",
      envVariables: {
        ...baseEnv,
        REMINDER_BASE_URL: gatewayBase
      }
    },
    {
      name: "agenda-ingest",
      timeout: 20,
      memorySize: 256,
      runtime: "Nodejs18.15",
      installDependency: false,
      description: "Chat capture endpoint: validate one sentence and write one task",
      envVariables: {
        ...baseEnv,
        AGENDA_OWNER_ID: secrets.agendaOwnerId,
        BOT_SHARED_SECRET: secrets.agendaBotSecret,
        SITE_URL: siteUrl
      }
    }
  ],
  gateway: {
    routes: [
      {
        path: "/api/reminder/device",
        target: "function:reminder-device",
        accessType: "DIRECT"
      },
      {
        path: "/api/reminder/done",
        target: "function:reminder-done",
        accessType: "DIRECT"
      },
      {
        path: "/api/agenda/ingest",
        target: "function:agenda-ingest",
        accessType: "DIRECT"
      }
    ]
  }
};

const outPath = path.join(__dirname, "..", "cloudbaserc.json");
fs.writeFileSync(outPath, JSON.stringify(config, null, 2), "utf8");
console.log("written:", outPath);
console.log("functions:", config.functions.map((f) => f.name).join(", "));
console.log("gateway routes:", config.gateway.routes.map((r) => r.path).join(", "));
console.log("REMINDER_BASE_URL:", config.functions[1].envVariables.REMINDER_BASE_URL);
console.log("REMINDER_DRY_RUN:", config.functions[1].envVariables.REMINDER_DRY_RUN);
