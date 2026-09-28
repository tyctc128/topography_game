import { defineConfig } from 'vite';

// iPad 透過 Cloudflare Tunnel（https://xxxx.trycloudflare.com）連進來測試，
// 所以要允許該網域；HMR 會沿用頁面的 https/443，不需另外設定。
const allowedHosts = ['.trycloudflare.com'];

export default defineConfig({
  // GitHub Pages 放在 https://<帳號>.github.io/topography_game/，建置時由 BASE_PATH 指定
  base: process.env.BASE_PATH ?? '/',
  server: { host: true, port: 5180, strictPort: true, allowedHosts },
  preview: { host: true, port: 5180, strictPort: true, allowedHosts },
  build: { target: 'es2022' },
});
