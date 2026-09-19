import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins: [{
    name: 'local-feature-fixture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/tests/features-fixture.html') return next();
        try {
          let html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
          html = html.replace('from "@cloudbase/js-sdk"', 'from "/tests/fake-cloudbase.js"')
            .replaceAll('"./src/', '"/src/')
            .replace('const configReady = Boolean(cloudConfig.env && cloudConfig.accessKey);', 'const configReady = true;')
            .replace('<body>', '<body><aside style="padding:10px;text-align:center;background:#fff2bd;color:#24211d;font:14px sans-serif">本地交互预览 · 示例数据，未连接云端</aside>');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await server.transformIndexHtml('/tests/features-fixture.html', html));
        } catch (error) { next(error); }
      });
    }
  }, {
    name: 'font-licenses',
    apply: 'build',
    async generateBundle() {
      for (const [source, name] of [
        ['SourceHanSerif-LICENSE.txt', 'SourceHanSerif-LICENSE.txt'],
        ['LXGWWenKai-OFL.txt', 'LXGWWenKai-OFL.txt'],
        ['wenkai/LICENSE.txt', 'LXGWWenKai-Webfont-LICENSE.txt']
      ]) {
        this.emitFile({type:'asset',fileName:`licenses/${name}`,source:await readFile(new URL(`./assets/fonts/${source}`,import.meta.url),'utf8')});
      }
    }
  }],
  build: {
    // CloudBase Web SDK v3 是组合 SDK；当前压缩后约 203 kB，属于预期范围。
    chunkSizeWarningLimit: 850
  }
});
