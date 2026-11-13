# README 配图

`app-mock.html` 是按当前界面手工复刻的静态示意图（不是真实截图），`app-mock.png` 是它的渲染产物。颜色、字号、间距与头像拼合口径取自 `src/renderer/src/styles.css` 和 `src/shared/avatar.ts`；头像直接引用 `src/renderer/src/assets/avatars/` 里的素材，不需要另外拷贝。

出图（Chrome / Chromium 均可）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1440,900 \
  --screenshot=docs/readme/app-mock.png \
  "file://$PWD/docs/readme/app-mock.html"
```

界面或文案有较大变化时，顺手更新 `app-mock.html` 再重新出图。
