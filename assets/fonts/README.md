# 字体

任务标题：Adobe Source Han Serif SC（思源宋体），SIL Open Font License 1.1。
每日补充：LXGW WenKai Regular（霞鹜文楷），SIL Open Font License 1.1。

思源宋体来自 Adobe 官方仓库，CN 可变 WOFF2，约 10.4MB。它只在任务标题出现时加载。
文楷使用作者仓库 Issue #24 推荐的 chawyehsu/lxgw-wenkai-webfont 1.7.0 网页字体包，仅保留 Regular 字重。
97 个 unicode-range 分片由浏览器按实际文字选取，不一次下载完整字库，文件在本站托管、不运行第三方脚本。
所有字体使用 font-display: swap：先显示系统字体，再替换，避免文字空白。
许可证包含原字体 OFL 及网页打包项目 MIT。构建会同时复制许可证至 dist/licenses。

参考：https://github.com/lxgw/LxgwWenKai/issues/24
网页字体：https://github.com/chawyehsu/lxgw-wenkai-webfont
