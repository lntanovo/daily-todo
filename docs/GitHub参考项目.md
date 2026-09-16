# GitHub 参考项目

以下项目用于学习结构和做法，不直接复制别人的视觉或品牌。

1. [TencentCloudBase/cloudbase-skills](https://github.com/TencentCloudBase/cloudbase-skills)
   - 官方 CloudBase 开发规范；重点参考 Web SDK v3、登录、数据库权限和部署流程。
2. [TencentCloudBase/awesome-cloudbase-examples](https://github.com/TencentCloudBase/awesome-cloudbase-examples)
   - 官方示例集合；重点参考 React/Vue Web 模板和 CloudBase 资源组织方式。
3. [waltermolina/todo-vanilla-pwa-example](https://github.com/waltermolina/todo-vanilla-pwa-example)
   - 原生 JavaScript 待办 PWA；以后做“安装到桌面”时可参考 manifest、Service Worker 和离线缓存。
4. [Shuunen/what-now](https://github.com/Shuunen/what-now)
   - 以重复任务为核心的极简待办；可参考 recurring task 的产品取舍和离线设计。
5. [Serkanbyx/simple-to-do-list](https://github.com/Serkanbyx/simple-to-do-list)
   - 无框架的任务 CRUD、键盘可访问性与 XSS 防护；适合对照检查现有实现。
6. [adryd325/oneko.js](https://github.com/adryd325/oneko.js)
   - MIT 许可的网页像素猫；v1.2 固定引用提交 `5281d057c4ea9bd4f6f997ee96ba30491aed16c0`，使用其精灵图并改写状态机，使宠物支持点击、鼠标/触屏拖动与位置记忆，并适应本站登录状态和动效开关。
7. [jhammann/sakura](https://github.com/jhammann/sakura)
   - MIT 许可的花瓣动画；v1.2 参考其随机尺寸、生命周期和缓慢飘落思路，重新设计为本站暖红色低密度花瓣。

## 本项目借鉴什么

- 学习官方 CloudBase 的身份与权限边界，不把密钥写进前端源码。
- 学习 PWA 的文件组织和离线策略，等网页稳定后再做“像 App 一样安装”。
- 学习可访问性与状态管理方式，但保留本项目自己的周视图、日期范围任务和暖色纸张排版。
- 宠物与花瓣只承担陪伴和完成反馈，悬浮层不拦截任务操作；第三方版权与许可证全文记录在 `THIRD_PARTY_NOTICES.md`。

## 明确不照搬什么

- 不复制第三方项目的 UI、文案、图标和品牌。
- 不引入超出首版需要的看板、协作、附件、聊天或复杂分类。
- 不使用仅靠 `localStorage` 的示例来冒充真正的多用户云同步。
