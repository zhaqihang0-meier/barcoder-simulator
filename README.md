# Barcoder — 条纹贝斯

ELECTRONICOS FANTASTICOS 风格的光电条码乐器 Web 模拟（Processing Barcoder 扫描模型）。

**作者：** by [極東踊羊Meier](https://search.bilibili.com/all?keyword=%E6%A5%B5%E6%9D%B1%E8%B8%8A%E7%BE%8AMeier)（bilibili）

## 本地运行

双击 `index.html`，或：

```bash
npx --yes serve .
```

浏览器需点击「开始演奏」解锁音频。

## 项目结构

| 路径 | 说明 |
|------|------|
| `index.html` | 页面入口 |
| `js/app.js` | 应用逻辑（单文件，支持 `file://`） |
| `css/style.css` | 样式 |

## 操作提示

- **按住鼠标**在条纹上移动扫描发声；**滚轮**调节扫描线宽
- 帧率 **0** = 手动滑动扫描；线宽 **0** = 单点激光
- 八条竖纹、方框滑音、方框直线放射纹、上传图片扫描
- **乐谱编写**：长条视口 + 滚轮抽拉，**Web MIDI** 键盘录入，导出整首长图 PNG
