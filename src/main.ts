import './styles/design.css';
import './styles/refinements.css';
import './styles/ipad.css';
import './styles/board.css';
import { App } from './app';
import { params } from './params';
import type { LevelDef, TerrainConfig } from './types';

async function boot(): Promise<void> {
  if (params.has('debug')) {
    // 不等待：除錯主控台載入慢或失敗都不影響遊戲
    import('eruda')
      .then(({ default: eruda }) => {
        eruda.init();
        eruda.position({ x: 20, y: window.innerHeight * 0.55 });
      })
      .catch((e) => console.warn('eruda 載入失敗', e));
  }
  const base = import.meta.env.BASE_URL;
  const [terrain, levels] = await Promise.all([
    fetch(`${base}config/terrain.json`).then((r) => r.json() as Promise<TerrainConfig>),
    fetch(`${base}config/levels.json`).then((r) => r.json() as Promise<LevelDef[]>),
  ]);
  const app = new App(document.getElementById('app')!, terrain, levels, params);
  if (params.has('debug')) (window as unknown as { __app: App }).__app = app;
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app')!.innerHTML = '<p style="padding:40px">載入失敗，請重新整理頁面。</p>';
});
