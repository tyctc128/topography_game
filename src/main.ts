import { params } from './params';
import { App } from './game/App';
import type { LevelDef, TerrainConfig } from './types';

async function boot(): Promise<void> {
  if (params.has('debug')) {
    // 不等待：除錯主控台載入慢或失敗都不影響遊戲
    import('eruda')
      .then(({ default: eruda }) => {
        eruda.init();
        eruda.position({ x: 20, y: window.innerHeight * 0.55 }); // 別擋到右下角的「檢查」
      })
      .catch((e) => console.warn('eruda 載入失敗', e));
  }
  const base = import.meta.env.BASE_URL;
  const [terrain, levels] = await Promise.all([
    fetch(`${base}config/terrain.json`).then((r) => r.json() as Promise<TerrainConfig>),
    fetch(`${base}config/levels.json`).then((r) => r.json() as Promise<LevelDef[]>),
  ]);
  new App(terrain, levels);
}

boot().catch((e) => {
  console.error(e);
  const msg = document.getElementById('start-msg');
  if (msg) msg.textContent = '載入失敗，請重新整理頁面';
});
