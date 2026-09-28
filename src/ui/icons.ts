// 線條圖示，沿用「社會地形design」原型的樣式
const paths: Record<string, string> = {
  mountain: 'M2 19 10 5l6 9 4-6 7 11Z M7 10l3 3 3-3',
  book: 'M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3Z M12 6v16',
  trophy: 'M7 3h10v6a5 5 0 0 1-10 0Z M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4M12 14v6m-4 1h8',
  grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  help: 'M9 8a3 3 0 1 1 4 3c-1 1-1 1-1 3m0 3v.1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  check: 'm5 12 4 4L19 6',
  target: 'M21 12a9 9 0 1 1-9-9m0 4a5 5 0 1 0 5 5M12 12l9-9m-5 0h5v5',
  bulb: 'M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 3H9Z',
  plus: 'M12 4v16M4 12h16',
  up: 'M12 21V3m-6 6 6-6 6 6',
  flat: 'M4 18h16M12 3v10m-5-5 5 5 5-5',
  smooth: 'M3 8c4-7 7 7 11 0s7 0 7 0M3 16c4-7 7 7 11 0s7 0 7 0',
  rotate: 'M20 8a9 9 0 1 0 1 7M20 2v6h-6',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  hand: 'M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 7-9 10-13 4l-4-5c-2-3 1-5 3-2l2 2',
  camera: 'M3 6h5l2-3h4l2 3h5v15H3ZM17 13a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  leaf: 'M20 3C8 2 2 7 5 15s17 6 15-12ZM6 19 16 8',
  clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  users: 'M16 21v-3c0-5-12-5-12 0v3m16 0v-3c0-2-1-3-3-4M14 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0m3-3a4 4 0 0 1 0 7',
  lock: 'M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4m-4 5v2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  sound: 'M3 9h4l5-5v16l-5-5H3ZM16 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14',
  close: 'M6 6l12 12M6 18 18 6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
};

export function icon(name: string, cls = ''): string {
  const w = name === 'mountain' ? 29 : 24;
  return `<svg class="${cls}" viewBox="0 0 ${w} 24" aria-hidden="true"><path d="${paths[name] ?? paths.mountain}"/></svg>`;
}

// 地形分頁的小圖示：平原、台地、丘陵、山地、盆地、臺灣剖面
const landPaths: Record<string, string> = {
  plain: 'M2 19h28M3 16h26',
  tableland: 'M2 21l7-14h15l7 14',
  hills: 'M1 20c4-1 3-12 8-12s5 10 9 8 5-8 8-7 4 11 7 11',
  mountain: 'M1 21 12 3l7 12 5-7 9 13',
  basin: 'M1 7l8 13h14L33 7',
  profile: 'M1 21l8-4 5-12 7 9 6 2 6 5',
};

export function landIcon(target: string): string {
  return `<svg class="terrain-icon" viewBox="0 0 35 25" aria-hidden="true"><path d="${landPaths[target] ?? landPaths.plain}"/><path d="M3 24h29" opacity=".3"/></svg>`;
}
