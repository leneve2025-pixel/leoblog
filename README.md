---
title: 光酱喵的知识星域
emoji: 🪐
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
---

# 🐱 光酱喵的知识星域 · 使用教程

一个猫咪星球主题的多人博客：任何人都可以注册、创建自己的「星球」、在星球里发表 Markdown 文章。数据全部存储在 GitHub 仓库里（不需要数据库），可一键部署到 Render。

---

## ✨ 功能一览

- 🪐 **星球系统**：登录后人人可创建星球（自定义名字、简介、颜色、图标），在星球里发表文章，所有人可浏览
- 📝 **Markdown 文章**：支持标题、加粗、代码块、引用、列表、图片、表格等，写作时可实时**预览**，发布后随时**编辑**
- 👤 **用户系统**：注册时可选性别（男/女/保密），个人中心可换**头像**（自动裁剪压缩成圆形）、改签名、改密码
- 🛡️ **管理员体系**：管理员凭邀请码注册，可管理账号、删文删星球；超级管理员还能改站点标题/副标题
- 🔐 密码使用 bcrypt 加密存储，Markdown 渲染经 DOMPurify 消毒防 XSS

---

## 🚀 第一步：申请 GITHUB_TOKEN

博客的所有数据（用户、星球、文章）都保存在 GitHub 仓库里，程序通过 Token 读写它。

1. 登录 GitHub，点击右上角头像 → **Settings**（设置）
2. 左侧菜单拉到最下面 → **Developer settings**
3. 选择 **Personal access tokens** → **Tokens (classic)**
4. 点击右上角 **Generate new token** → **Generate new token (classic)**
5. 填写：
   - **Note**：随便写，比如 `lux-blog-token`
   - **Expiration**：有效期，建议选 `No expiration`（永不过期）或 1 年
   - **勾选权限**：只需勾选 **`repo`**（第一个大项，全选它下面的子项）
6. 拉到底部点 **Generate token**
7. **立刻复制**生成的 `ghp_xxxxxxxxxxxx` —— 它只显示这一次！

> ⚠️ Token 等于仓库的钥匙，不要发给任何人，也不要提交进代码仓库。

## 📦 第二步：创建数据仓库

1. 在 GitHub 新建一个仓库，名字必须是 **`lux-s-blog`**（用户名 `lux-cmd2026` 下）
2. 建议设为 **Private**（私有），因为里面有用户数据
3. 不需要 README，空仓库即可，程序首次启动会自动初始化

> 想用别的仓库名？设置环境变量 `GITHUB_OWNER` 和 `GITHUB_REPO` 覆盖即可。

## 💻 第三步：本地运行

```bash
cd "E:\lux's blog"
npm install
```

**设置 Token 后启动**（Windows CMD）：

```cmd
set GITHUB_TOKEN=ghp_你的token
npm start
```

**Windows PowerShell**：

```powershell
$env:GITHUB_TOKEN="ghp_你的token"
npm start
```

看到 `光酱喵的知识星域启动啦喵~` 就成功了，用浏览器打开控制台里显示的地址。

> 💡 也可以直接双击 `启动.bat`（已内置 Token、系统证书设置和 3001 端口）。

## ❗ 常见问题

**1. 报 `unable to verify the first certificate`**

电脑上的杀毒软件（360、电脑管家等）或代理拦截了 HTTPS 请求。启动前先执行：

```cmd
set NODE_OPTIONS=--use-system-ca
```

让 Node 使用 Windows 系统证书库（`启动.bat` 里已经加好了）。

**2. 报 `EADDRINUSE: address already in use :::3000`**

3000 端口被其他程序（比如你另一个博客）占用。换个端口启动：

```cmd
set PORT=3001
npm start
```

**3. 报 `初始化失败: Not Found` / `Bad credentials`**

数据仓库不存在或 Token 无效，回到第二步检查仓库名和 Token。

## 👑 默认超级管理员

| 项目 | 值 |
|---|---|
| 用户名 | `光酱喵` |
| 密码 | `#include` |

首次启动时自动创建。**登录后请立刻到「个人中心 → 修改密码」换成自己的密码！**
管理员注册邀请码默认为 `guangjiang666`（在登录弹窗的「管理员注册」页使用）。

## ☁️ 第四步：部署到 Render（可选）

1. 把本项目的代码推到**另一个** GitHub 仓库（注意：这是代码仓库，和数据仓库 `lux-s-blog` 是两个仓库）
2. 打开 [render.com](https://render.com) → **New** → **Web Service** → 连接代码仓库
3. 配置：
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
4. **Environment Variables** 里添加：
   - `GITHUB_TOKEN` = `ghp_你的token`
5. 点 **Deploy**，等一两分钟就能通过 Render 给的网址访问了

## 🔧 全部环境变量（都有默认值，可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | 无（**必填**） | 上面申请的 Token |
| `GITHUB_OWNER` | `lux-cmd2026` | 数据仓库的所有者 |
| `GITHUB_REPO` | `lux-s-blog` | 数据仓库名 |
| `ADMIN_CODE` | `guangjiang666` | 管理员注册邀请码 |
| `SUPER_ADMIN_USER` | `光酱喵` | 超管用户名（仅首次初始化生效） |
| `SUPER_ADMIN_PASS` | `#include` | 超管初始密码（仅首次初始化生效） |
| `SESSION_SECRET` | 内置 | 会话加密密钥，建议部署时改成长随机串 |
| `PORT` | `3000` | 端口（Render 会自动注入） |

## 📖 使用指南

| 我想… | 怎么做 |
|---|---|
| 注册账号 | 右上角「登录 / 注册」→「注册」页，填用户名、密码、性别 |
| 换头像/改性别 | 登录后点右上角头像 → 个人中心 |
| 创建星球 | 首页「创建我的星球」，选颜色和图标 |
| 写文章 | 进入星球 →「在这颗星球发表文章」，支持 Markdown，可预览 |
| 编辑文章 | 打开自己的文章 →「编辑」（作者/星球主/管理员可用） |
| 注册管理员 | 登录弹窗 →「管理员注册」页，输入邀请码 |
| 管理账号 | 管理员登录后点右上角「后台」，可重置密码（重置为 123456）、删号 |
| 改博客标题 | 超管登录 → 后台 → 站点设置 |

## 🗂️ 数据仓库结构（自动生成，无需手动维护）

```
lux-s-blog/
├── config.json            # 站点标题等配置
├── users/<用户名>.json     # 普通用户
├── admin/<用户名>.json     # 管理员
├── planets/index.json     # 星球索引
├── planets/<id>.json      # 星球详情 + 文章列表
└── posts/<id>.json        # 文章内容
```

---

🐾 用 💖 和星球做成
