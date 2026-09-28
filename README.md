# 黏土捏地形

iPad Safari 上的網頁遊戲：孩子用手指（或前鏡頭手勢）捏虛擬黏土，做出臺灣的平原、台地、丘陵、山地、盆地。

- 一根手指：在黏土上用左下角的工具捏；在土盤外面拖曳可以自由旋轉（放開會順勢滑動）
- 從黏土罐拖到土盤上放開：放一團黏土
- 兩根手指：拖曳旋轉、張開縮放；滑鼠：右鍵拖曳旋轉、滾輪縮放
- 右下角按鈕：左右轉 45°、俯視、側看、還原

## 在 iPad 上測試

需要兩個終端機視窗：

```bash
npm install        # 第一次
npm run dev        # 開發伺服器 http://localhost:5180（會自動下載手部模型）
npm run tunnel     # 產生 https://xxxx.trycloudflare.com，用 iPad Safari 打開
```

- iPad 一定要用 **https** 網址才能開鏡頭；臨時網址每次重開 tunnel 都會變。
- 改程式存檔後，iPad 會自動重新整理。

## 網址參數

| 參數 | 用途 |
| --- | --- |
| `?level=5` | 選好鏡頭後直接進第 5 關（盆地） |
| `?debug=1` | 顯示手部骨架、手勢狀態、FPS、判定數值，並載入 eruda 主控台 |

也可以寫成 `#level=5&debug=1`。

## 調整

- 海拔門檻、色階、等高線間距：`public/config/terrain.json`
- 關卡、起始黏土、黏土罐容量、提示文字：`public/config/levels.json`
- 手勢靈敏度：`src/gesture/GestureRecognizer.ts` 的 `G`

## 測試

```bash
npm test           # 判定、黏土、手勢的單元測試
```
