# Paw 产品展示站 🐾

一个纯静态的 Paw AI Agent 产品展示页面，使用原生 HTML / CSS / JavaScript 构建，无需任何构建工具或依赖安装。

## 如何打开

### 方式一：直接浏览器打开（推荐）

用任意现代浏览器直接打开 `index.html` 文件：

```bash
# macOS
open index.html

# Linux
xdg-open index.html

# Windows
start index.html
```

### 方式二：本地静态服务器（可选）

如果你希望体验更真实的页面加载行为，可以用 Python 或 Node.js 启动一个简单服务器：

```bash
# Python 3
python3 -m http.server 8000
# 然后访问 http://localhost:8000

# Node.js (npx)
npx serve .
```

## 功能说明

| 功能 | 说明 |
|------|------|
| **顶栏导航** | 粘性顶部导航栏，包含品牌标识、能力/记忆演示/FAQ 链接、深色/浅色主题切换按钮 |
| **Hero 区域** | 主标题、副标题、主按钮「探索能力」，引导用户浏览核心功能 |
| **三列能力卡片** | 展示 Paw 三大核心能力：多轮对话、长期记忆、桌面 Plan·Context·Memory，每张卡片包含描述和功能列表 |
| **记忆演示** | 模拟的长期记忆数据列表，包含 6 条 preference（偏好）和 decision（决策）类型的记忆条目；支持按「全部/偏好/决策」筛选 |
| **FAQ** | 至少 3 条常见问题，点击展开/收起答案（手风琴效果） |
| **深色/浅色主题** | 点击右上角 🌙/☀️ 按钮切换主题，选择结果存入 localStorage，刷新页面后保持；首次访问跟随系统偏好 |
| **响应式设计** | 适配桌面、平板和手机屏幕 |

## 文件结构

```
.
├── index.html       # 主页面（完整单页）
├── styles.css       # 样式表（浅色默认 + data-theme="dark" 深色变量）
├── theme.js         # 深色/浅色主题切换逻辑
├── memory-demo.js   # 记忆演示的假数据与筛选逻辑
└── README.md        # 本文件
```

## 技术栈

- **HTML5** — 语义化标签（nav, section, footer）
- **CSS3** — CSS 自定义属性（变量）、Grid 布局、Flexbox、动画、媒体查询
- **JavaScript** — 原生 ES6+，无第三方依赖
