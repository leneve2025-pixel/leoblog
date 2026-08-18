const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Octokit } = require('@octokit/rest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 绕过被污染的 hosts / 本地DNS（自适应） ============
// 某些 GitHub 加速工具会把 api.github.com 指向 127.0.0.1、把 DNS 改成本地代理，
// 工具没开时连接直接被拒（ECONNREFUSED 127.0.0.1:443）。
// 策略：先正常解析；仅当结果被污染成回环地址时，才改用公共 DNS 直连解析。
// 正常网络（如 Render 服务器）下走系统 DNS，零影响。
const dns = require('dns');
const origLookup = dns.lookup;
const dnsResolver = new dns.Resolver();
try { dnsResolver.setServers(['223.5.5.5', '119.29.29.29', '8.8.8.8']); } catch (e) {}
const isGithubHost = h => /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.dev)$/i.test(h);
const isLoopback = ip => /^127\.|^::1$|^0:0:0:0:0:0:0:1$/.test(ip);
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (!isGithubHost(hostname)) return origLookup(hostname, options, callback);
  origLookup(hostname, options, (err, address, family) => {
    const polluted = !err && address &&
      (options && options.all ? address.every(a => isLoopback(a.address)) : isLoopback(address));
    if (!polluted) return callback(err, address, family);
    dnsResolver.resolve4(hostname, (err2, addrs) => {
      if (err2 || !addrs || !addrs.length) return callback(err, address, family);
      if (options && options.all) callback(null, addrs.map(a => ({ address: a, family: 4 })));
      else callback(null, addrs[0], 4);
    });
  });
};

// ============ 配置（可用环境变量覆盖） ============
const CONFIG = {
  githubToken: process.env.GITHUB_TOKEN || '',
  repoOwner: process.env.GITHUB_OWNER || 'leneve2025-pixel',
  repoName: process.env.GITHUB_REPO || 'leoblogdata',
  adminCode: process.env.ADMIN_CODE || 'lux2026', // 管理员注册邀请码
  superAdmin: {
    username: process.env.SUPER_ADMIN_USER || '光酱喵',
    password: process.env.SUPER_ADMIN_PASS || '#include'
  }
};

const octokit = new Octokit({ auth: CONFIG.githubToken });

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'guangjiang-meow-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 天
}));
app.use(express.static('public'));

// ============ GitHub 存储层 ============
const shaCache = {};

async function getFileContent(filePath) {
  try {
    const res = await octokit.repos.getContent({
      owner: CONFIG.repoOwner,
      repo: CONFIG.repoName,
      path: filePath
    });
    shaCache[filePath] = res.data.sha;
    return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function saveFileContent(filePath, content, message) {
  const body = {
    owner: CONFIG.repoOwner,
    repo: CONFIG.repoName,
    path: filePath,
    message: message || ('更新 ' + filePath),
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
  };
  if (shaCache[filePath]) body.sha = shaCache[filePath];
  const res = await octokit.repos.createOrUpdateFileContents(body);
  shaCache[filePath] = res.data.content.sha;
  return res;
}

async function deleteFile(filePath, message) {
  let sha = shaCache[filePath];
  if (!sha) {
    const res = await octokit.repos.getContent({
      owner: CONFIG.repoOwner, repo: CONFIG.repoName, path: filePath
    });
    sha = res.data.sha;
  }
  await octokit.repos.deleteFile({
    owner: CONFIG.repoOwner, repo: CONFIG.repoName,
    path: filePath, message: message || ('删除 ' + filePath), sha
  });
  delete shaCache[filePath];
}

function genId(str) {
  return crypto.createHash('md5').update(str + Date.now() + Math.random()).digest('hex').slice(0, 10);
}

// ============ 用户查找（user/ 与 admin/ 两个文件夹） ============
async function findAccount(username) {
  let acc = await getFileContent('admin/' + username + '.json');
  if (acc) return { ...acc, _path: 'admin/' + username + '.json' };
  acc = await getFileContent('users/' + username + '.json');
  if (acc) return { ...acc, _path: 'users/' + username + '.json' };
  return null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    gender: u.gender || 'secret',
    avatar: u.avatar || '',
    bio: u.bio || '',
    role: u.role,
    createdAt: u.createdAt
  };
}

// ============ 权限中间件 ============
async function isLoggedIn(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: '请先登录喵~' });
  next();
}

async function isAdmin(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: '请先登录喵~' });
  const acc = await findAccount(req.session.username);
  if (!acc || (acc.role !== 'admin' && acc.role !== 'super_admin')) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  req.account = acc;
  next();
}

async function isSuperAdmin(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: '请先登录喵~' });
  const acc = await findAccount(req.session.username);
  if (!acc || acc.role !== 'super_admin') {
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  req.account = acc;
  next();
}

// ============ 初始化仓库 ============
async function initRepo() {
  const config = await getFileContent('config.json');
  if (!config) {
    await saveFileContent('config.json', {
      blogTitle: "光酱喵的知识星域",
      subtitle: '在星球之间，写下闪闪发光的故事 ✨'
    }, '初始化站点配置');
  }
  const planetsIndex = await getFileContent('planets/index.json');
  if (!planetsIndex) {
    await saveFileContent('planets/index.json', { planets: [] }, '初始化星球索引');
  }
  const superAcc = await getFileContent('admin/' + CONFIG.superAdmin.username + '.json');
  if (!superAcc) {
    await saveFileContent('admin/' + CONFIG.superAdmin.username + '.json', {
      username: CONFIG.superAdmin.username,
      password: bcrypt.hashSync(CONFIG.superAdmin.password, 10),
      gender: 'secret',
      avatar: '',
      bio: '本站站长喵~',
      role: 'super_admin',
      createdAt: new Date().toISOString()
    }, '创建超级管理员');
    console.log('超级管理员已创建:', CONFIG.superAdmin.username);
  }
}

// ============ 认证 API ============
// 普通用户注册 -> users/ 文件夹
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, gender } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (!/^[\w一-龥-]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需为 2-20 位中英文/数字/下划线' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (await findAccount(username)) return res.status(400).json({ error: '这个名字已经被别的猫咪用啦' });

    const user = {
      username,
      password: bcrypt.hashSync(password, 10),
      gender: ['male', 'female', 'secret'].includes(gender) ? gender : 'secret',
      avatar: '',
      bio: '',
      role: 'user',
      createdAt: new Date().toISOString()
    };
    await saveFileContent('users/' + username + '.json', user, '新用户注册: ' + username);
    req.session.username = username;
    res.json({ success: true, user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员注册 -> admin/ 文件夹（需要邀请码）
app.post('/api/auth/register-admin', async (req, res) => {
  try {
    const { username, password, gender, adminCode } = req.body;
    if (adminCode !== CONFIG.adminCode) return res.status(403).json({ error: '管理员邀请码不正确喵' });
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (!/^[\w一-龥-]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需为 2-20 位中英文/数字/下划线' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (await findAccount(username)) return res.status(400).json({ error: '用户名已存在' });

    const admin = {
      username,
      password: bcrypt.hashSync(password, 10),
      gender: ['male', 'female', 'secret'].includes(gender) ? gender : 'secret',
      avatar: '',
      bio: '',
      role: 'admin',
      createdAt: new Date().toISOString()
    };
    await saveFileContent('admin/' + username + '.json', admin, '新管理员注册: ' + username);
    req.session.username = username;
    res.json({ success: true, user: publicUser(admin) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const acc = await findAccount(username);
    if (!acc || !bcrypt.compareSync(password || '', acc.password)) {
      return res.status(401).json({ error: '用户名或密码错误喵' });
    }
    req.session.username = username;
    res.json({ success: true, user: publicUser(acc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/status', async (req, res) => {
  try {
    if (!req.session.username) return res.json({ loggedIn: false });
    const acc = await findAccount(req.session.username);
    if (!acc) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: publicUser(acc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 个人资料（性别 / 头像 / 简介 / 密码） ============
app.put('/api/profile', isLoggedIn, async (req, res) => {
  try {
    const acc = await findAccount(req.session.username);
    const { gender, bio } = req.body;
    if (gender && ['male', 'female', 'secret'].includes(gender)) acc.gender = gender;
    if (typeof bio === 'string') acc.bio = bio.slice(0, 100);
    delete acc._path;
    await saveFileContent((acc.role === 'user' ? 'users/' : 'admin/') + acc.username + '.json', acc, '更新资料: ' + acc.username);
    res.json({ success: true, user: publicUser(acc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/avatar', isLoggedIn, async (req, res) => {
  try {
    const { avatar } = req.body; // base64 dataURL，前端已压缩
    if (!avatar || !avatar.startsWith('data:image/')) return res.status(400).json({ error: '头像格式不正确' });
    if (avatar.length > 400 * 1024) return res.status(400).json({ error: '头像太大啦，请换一张' });
    const acc = await findAccount(req.session.username);
    acc.avatar = avatar;
    const p = acc._path; delete acc._path;
    await saveFileContent(p, acc, '更新头像: ' + acc.username);
    res.json({ success: true, user: publicUser(acc) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile/password', isLoggedIn, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const acc = await findAccount(req.session.username);
    if (!bcrypt.compareSync(oldPassword || '', acc.password)) {
      return res.status(401).json({ error: '原密码错误' });
    }
    acc.password = bcrypt.hashSync(newPassword, 10);
    const p = acc._path; delete acc._path;
    await saveFileContent(p, acc, '修改密码: ' + acc.username);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 查看任意用户公开资料
app.get('/api/users/:username', async (req, res) => {
  try {
    const acc = await findAccount(req.params.username);
    if (!acc) return res.status(404).json({ error: '用户不存在' });
    res.json(publicUser(acc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 星球 API ============
app.get('/api/planets', async (req, res) => {
  try {
    const index = await getFileContent('planets/index.json') || { planets: [] };
    res.json(index.planets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/planets', isLoggedIn, async (req, res) => {
  try {
    const { name, desc, color, icon, postPerm } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '星球名字不能为空' });
    if (name.length > 20) return res.status(400).json({ error: '星球名字太长啦（20字以内）' });
    // 创作权限：personal=个人创作(仅星球主) / everyone=所有人 / owner_admin=管理员+个人创作
    const perm = ['personal', 'everyone', 'owner_admin'].includes(postPerm) ? postPerm : 'everyone';

    const id = genId(name + req.session.username);
    const planet = {
      id,
      name: name.trim(),
      desc: (desc || '').slice(0, 100),
      color: color || 'pink',
      icon: icon || '🪐',
      postPerm: perm,
      owner: req.session.username,
      createdAt: new Date().toISOString(),
      posts: []
    };
    await saveFileContent('planets/' + id + '.json', planet, '创建星球: ' + name);

    const index = await getFileContent('planets/index.json') || { planets: [] };
    index.planets.push({
      id, name: planet.name, desc: planet.desc, color: planet.color,
      icon: planet.icon, postPerm: perm, owner: planet.owner, createdAt: planet.createdAt, postCount: 0
    });
    await saveFileContent('planets/index.json', index, '星球索引 + ' + name);
    res.json({ success: true, planet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/planets/:id', async (req, res) => {
  try {
    const planet = await getFileContent('planets/' + req.params.id + '.json');
    if (!planet) return res.status(404).json({ error: '星球不存在' });
    planet.posts = (planet.posts || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(planet);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/planets/:id', isLoggedIn, async (req, res) => {
  try {
    const planet = await getFileContent('planets/' + req.params.id + '.json');
    if (!planet) return res.status(404).json({ error: '星球不存在' });
    const acc = await findAccount(req.session.username);
    const canDelete = planet.owner === req.session.username || acc.role === 'admin' || acc.role === 'super_admin';
    if (!canDelete) return res.status(403).json({ error: '只有星球主或管理员可以删除星球' });

    // 删除星球下所有文章
    for (const p of planet.posts || []) {
      try { await deleteFile('posts/' + p.id + '.json', '删除星球文章: ' + p.title); } catch (e) {}
    }
    await deleteFile('planets/' + req.params.id + '.json', '删除星球: ' + planet.name);
    const index = await getFileContent('planets/index.json') || { planets: [] };
    index.planets = index.planets.filter(p => p.id !== req.params.id);
    await saveFileContent('planets/index.json', index, '星球索引 - ' + planet.name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 文章 API ============
app.post('/api/planets/:id/posts', isLoggedIn, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容都不能为空喵' });
    if (title.length > 60) return res.status(400).json({ error: '标题太长啦（60字以内）' });
    const planet = await getFileContent('planets/' + req.params.id + '.json');
    if (!planet) return res.status(404).json({ error: '星球不存在' });

    // 创作权限校验（管理员含超级管理员）
    const poster = await findAccount(req.session.username);
    const posterIsAdmin = poster && (poster.role === 'admin' || poster.role === 'super_admin');
    const isPlanetOwner = planet.owner === req.session.username;
    const perm = planet.postPerm || 'everyone';
    if (perm === 'personal' && !isPlanetOwner) {
      return res.status(403).json({ error: '这颗星球是「个人创作」模式，仅星球主可以发文喵~' });
    }
    if (perm === 'owner_admin' && !isPlanetOwner && !posterIsAdmin) {
      return res.status(403).json({ error: '这颗星球仅星球主和管理员可以发文喵~' });
    }

    const id = genId(title + content);
    const post = {
      id,
      planetId: planet.id,
      planetName: planet.name,
      title: title.trim(),
      content,
      author: req.session.username,
      createdAt: new Date().toISOString(),
      views: 0
    };
    await saveFileContent('posts/' + id + '.json', post, '发布文章: ' + title);

    planet.posts = planet.posts || [];
    planet.posts.push({ id, title: post.title, author: post.author, createdAt: post.createdAt, views: 0 });
    await saveFileContent('planets/' + planet.id + '.json', planet, '星球新文章: ' + title);

    const index = await getFileContent('planets/index.json') || { planets: [] };
    const idx = index.planets.findIndex(p => p.id === planet.id);
    if (idx >= 0) {
      index.planets[idx].postCount = planet.posts.length;
      await saveFileContent('planets/index.json', index, '更新星球文章数');
    }
    res.json({ success: true, post });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    post.views = (post.views || 0) + 1;
    await saveFileContent('posts/' + post.id + '.json', post, '阅读 +1: ' + post.title);
    const planet = await getFileContent('planets/' + post.planetId + '.json');
    if (planet) post.planetOwner = planet.owner;
    // 附带评论者头像（不写入文件，仅用于本次响应）
    const commentAuthors = [...new Set((post.comments || []).map(c => c.author))];
    if (commentAuthors.length) {
      post.commentAvatars = {};
      for (const name of commentAuthors) {
        try {
          const a = await findAccount(name);
          post.commentAvatars[name] = a ? (a.avatar || '') : '';
        } catch (e) { post.commentAvatars[name] = ''; }
      }
    }
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/posts/:id', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const acc = await findAccount(req.session.username);
    const planet = await getFileContent('planets/' + post.planetId + '.json');
    const canEdit = post.author === req.session.username
      || (planet && planet.owner === req.session.username)
      || acc.role === 'admin' || acc.role === 'super_admin';
    if (!canEdit) return res.status(403).json({ error: '只有作者、星球主或管理员可以编辑' });

    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容都不能为空喵' });
    if (title.length > 60) return res.status(400).json({ error: '标题太长啦（60字以内）' });
    post.title = title.trim();
    post.content = content;
    post.updatedAt = new Date().toISOString();
    await saveFileContent('posts/' + post.id + '.json', post, '编辑文章: ' + post.title);

    // 同步星球内的标题
    if (planet) {
      const p = (planet.posts || []).find(x => x.id === post.id);
      if (p) { p.title = post.title; await saveFileContent('planets/' + planet.id + '.json', planet, '同步文章标题: ' + post.title); }
    }
    res.json({ success: true, post });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const acc = await findAccount(req.session.username);
    const planet = await getFileContent('planets/' + post.planetId + '.json');
    const canDelete = post.author === req.session.username
      || (planet && planet.owner === req.session.username)
      || acc.role === 'admin' || acc.role === 'super_admin';
    if (!canDelete) return res.status(403).json({ error: '只有作者、星球主或管理员可以删除' });

    await deleteFile('posts/' + post.id + '.json', '删除文章: ' + post.title);
    if (planet) {
      planet.posts = (planet.posts || []).filter(p => p.id !== post.id);
      await saveFileContent('planets/' + planet.id + '.json', planet, '移除文章: ' + post.title);
      const index = await getFileContent('planets/index.json') || { planets: [] };
      const idx = index.planets.findIndex(p => p.id === planet.id);
      if (idx >= 0) {
        index.planets[idx].postCount = planet.posts.length;
        await saveFileContent('planets/index.json', index, '更新星球文章数');
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 文章互动 API（赞 / 收藏 / 评论 / 精华） ============
app.post('/api/posts/:id/like', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    post.likes = post.likes || [];
    const i = post.likes.indexOf(req.session.username);
    const liked = i < 0;
    if (liked) post.likes.push(req.session.username); else post.likes.splice(i, 1);
    await saveFileContent('posts/' + post.id + '.json', post, (liked ? '点赞: ' : '取消点赞: ') + post.title);
    res.json({ success: true, liked, likes: post.likes.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/favorite', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const acc = await findAccount(req.session.username);
    post.favoritedBy = post.favoritedBy || [];
    acc.favorites = acc.favorites || [];
    const i = post.favoritedBy.indexOf(req.session.username);
    const favorited = i < 0;
    if (favorited) {
      post.favoritedBy.push(req.session.username);
      if (!acc.favorites.some(f => f.id === post.id)) {
        acc.favorites.push({
          id: post.id, title: post.title, planetId: post.planetId, planetName: post.planetName,
          author: post.author, createdAt: post.createdAt, addedAt: new Date().toISOString()
        });
      }
    } else {
      post.favoritedBy.splice(i, 1);
      acc.favorites = acc.favorites.filter(f => f.id !== post.id);
    }
    await saveFileContent('posts/' + post.id + '.json', post, (favorited ? '收藏: ' : '取消收藏: ') + post.title);
    const p = acc._path; delete acc._path;
    await saveFileContent(p, acc, '更新收藏库: ' + acc.username);
    res.json({ success: true, favorited, favCount: post.favoritedBy.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 我的收藏库（自动清理已删除的文章）
app.get('/api/favorites', isLoggedIn, async (req, res) => {
  try {
    const acc = await findAccount(req.session.username);
    const favs = acc.favorites || [];
    const alive = [];
    for (const f of favs) {
      if (await getFileContent('posts/' + f.id + '.json')) alive.push(f);
    }
    if (alive.length !== favs.length) {
      acc.favorites = alive;
      const p = acc._path; delete acc._path;
      await saveFileContent(p, acc, '清理失效收藏: ' + acc.username);
    }
    res.json(alive.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/comments', isLoggedIn, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: '评论内容不能为空喵' });
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const comment = {
      id: genId('comment' + req.session.username),
      author: req.session.username,
      content: content.trim().slice(0, 500),
      createdAt: new Date().toISOString()
    };
    post.comments = post.comments || [];
    post.comments.push(comment);
    await saveFileContent('posts/' + post.id + '.json', post, '新评论: ' + post.title);
    res.json({ success: true, comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id/comments/:cid', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const comment = (post.comments || []).find(c => c.id === req.params.cid);
    if (!comment) return res.status(404).json({ error: '评论不存在' });
    const acc = await findAccount(req.session.username);
    const planet = await getFileContent('planets/' + post.planetId + '.json');
    const canDelete = comment.author === req.session.username
      || post.author === req.session.username
      || (planet && planet.owner === req.session.username)
      || acc.role === 'admin' || acc.role === 'super_admin';
    if (!canDelete) return res.status(403).json({ error: '只有评论者、作者、星球主或管理员可以删除评论' });
    post.comments = post.comments.filter(c => c.id !== req.params.cid);
    await saveFileContent('posts/' + post.id + '.json', post, '删除评论: ' + post.title);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 精华（星球主或管理员可设置，管理员含超级管理员）
app.post('/api/posts/:id/feature', isLoggedIn, async (req, res) => {
  try {
    const post = await getFileContent('posts/' + req.params.id + '.json');
    if (!post) return res.status(404).json({ error: '文章不存在' });
    const planet = await getFileContent('planets/' + post.planetId + '.json');
    const acc = await findAccount(req.session.username);
    const isAdm = acc.role === 'admin' || acc.role === 'super_admin';
    if (!planet || (planet.owner !== req.session.username && !isAdm)) {
      return res.status(403).json({ error: '只有星球主或管理员可以设置精华' });
    }
    post.featured = !post.featured;
    await saveFileContent('posts/' + post.id + '.json', post, (post.featured ? '设为精华: ' : '取消精华: ') + post.title);
    const entry = (planet.posts || []).find(p => p.id === post.id);
    if (entry) {
      entry.featured = post.featured;
      await saveFileContent('planets/' + planet.id + '.json', planet, '同步精华标记: ' + post.title);
    }
    res.json({ success: true, featured: post.featured });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 管理后台 API ============
app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const list = [];
    for (const dir of ['users', 'admin']) {
      try {
        const res0 = await octokit.repos.getContent({
          owner: CONFIG.repoOwner, repo: CONFIG.repoName, path: dir
        });
        for (const f of res0.data) {
          if (f.name.endsWith('.json')) {
            const acc = await getFileContent(dir + '/' + f.name);
            if (acc) list.push(publicUser(acc));
          }
        }
      } catch (e) { /* 目录不存在则跳过 */ }
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:username', isAdmin, async (req, res) => {
  try {
    const target = await findAccount(req.params.username);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'super_admin') return res.status(403).json({ error: '不能删除超级管理员' });
    if (req.account.role !== 'super_admin' && target.role !== 'user') {
      return res.status(403).json({ error: '只有超级管理员可以删除管理员' });
    }
    await deleteFile(target._path, '删除账号: ' + target.username);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:username/reset-password', isAdmin, async (req, res) => {
  try {
    const target = await findAccount(req.params.username);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.role === 'super_admin') return res.status(403).json({ error: '不能重置超级管理员密码' });
    if (req.account.role !== 'super_admin' && target.role !== 'user') {
      return res.status(403).json({ error: '只有超级管理员可以重置管理员密码' });
    }
    target.password = bcrypt.hashSync('123456', 10);
    const p = target._path; delete target._path;
    await saveFileContent(p, target, '重置密码: ' + target.username);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', async (req, res) => {
  try {
    res.json(await getFileContent('config.json') || { blogTitle: "光酱喵的知识星域", subtitle: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config', isSuperAdmin, async (req, res) => {
  try {
    const config = await getFileContent('config.json') || {};
    if (req.body.blogTitle) config.blogTitle = req.body.blogTitle.slice(0, 30);
    if (typeof req.body.subtitle === 'string') config.subtitle = req.body.subtitle.slice(0, 60);
    if (typeof req.body.announcement === 'string') config.announcement = req.body.announcement.slice(0, 500);
    await saveFileContent('config.json', config, '更新站点配置');
    res.json({ success: true, config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA 兜底
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initRepo().then(() => {
  app.listen(PORT, () => console.log(`光酱喵的知识星域启动啦喵~ http://localhost:${PORT}`));
}).catch(e => {
  console.error('初始化失败:', e.message);
  app.listen(PORT, () => console.log(`(初始化失败但仍启动) http://localhost:${PORT}`));
});
