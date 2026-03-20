require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const ADMIN_PASSWORD = 'muan0346';

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeBase = path.basename(file.originalname || 'media', ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    cb(null, Date.now() + '_' + safeBase + ext);
  }
});

function fileFilter(req, file, cb) {
  const allowed = [...IMAGE_TYPES, ...VIDEO_TYPES];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error('이미지(jpg, png, webp, gif) 또는 영상(mp4, webm, ogg, mov)만 업로드할 수 있습니다.'));
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

const db = new Database(path.join(__dirname, 'crime_guide.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    media_path TEXT,
    media_type TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);


// 기존 카테고리 구조를 최신 구조로 자동 정리
db.exec(`
  UPDATE posts SET category = '__tmp_foreign__' WHERE category = 'foreign';
  UPDATE posts SET category = 'foreign' WHERE category = 'phishing';
  UPDATE posts SET category = 'notice' WHERE category = '__tmp_foreign__';
`);


const categories = [
  { key: 'theft', name: '절도예방수칙', icon: '🚨' },
  { key: 'fraud', name: '사기예방수칙', icon: '💰' },
  { key: 'foreign', name: '외국인 범죄예방수칙', icon: '🌍' },
  { key: 'notice', name: '무안경찰알림', icon: '📢' }
];

function categoryInfo(key) {
  return categories.find(c => c.key === key);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

function getMediaKind(mimetype) {
  if (IMAGE_TYPES.includes(mimetype)) return 'image';
  if (VIDEO_TYPES.includes(mimetype)) return 'video';
  return '';
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  }
}));

app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(publicDir, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.sendFile(path.join(publicDir, 'sw.js'));
});

app.get('/', (req, res) => {
  res.render('index', { categories, isAdmin: !!req.session.isAdmin });
});

app.get('/category/:category', (req, res) => {
  const info = categoryInfo(req.params.category);
  if (!info) return res.status(404).send('존재하지 않는 카테고리입니다.');

  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE category = ?
    ORDER BY id DESC
  `).all(req.params.category);

  res.render('category', {
    info,
    posts,
    isAdmin: !!req.session.isAdmin
  });
});

app.get('/admin/login', (req, res) => {
  res.render('login', { error: '', isAdmin: !!req.session.isAdmin });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  return res.render('login', { error: '비밀번호가 올바르지 않습니다.', isAdmin: false });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});


app.get('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/admin');

  res.render('edit', {
    post,
    categories,
    isAdmin: true,
    error: ''
  });
});

app.post('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  upload.single('media')(req, res, function(err) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.redirect('/admin');

    if (err) {
      return res.status(400).render('edit', {
        post,
        categories,
        isAdmin: true,
        error: err.message || '업로드 중 오류가 발생했습니다.'
      });
    }

    const { category, title, content, delete_media } = req.body;
    if (!category || !title || !content) {
      return res.status(400).render('edit', {
        post,
        categories,
        isAdmin: true,
        error: '카테고리, 제목, 내용을 모두 입력해주세요.'
      });
    }

    let mediaPath = post.media_path || '';
    let mediaType = post.media_type || '';

    if (delete_media === '1' && mediaPath) {
      const oldPath = path.join(publicDir, mediaPath.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) {}
      }
      mediaPath = '';
      mediaType = '';
    }

    if (req.file) {
      if (mediaPath) {
        const oldPath = path.join(publicDir, mediaPath.replace(/^\//, ''));
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch (e) {}
        }
      }
      mediaPath = `/uploads/${req.file.filename}`;
      mediaType = getMediaKind(req.file.mimetype);
    }

    db.prepare(`
      UPDATE posts
      SET category = ?, title = ?, content = ?, media_path = ?, media_type = ?
      WHERE id = ?
    `).run(category, title.trim(), content.trim(), mediaPath, mediaType, req.params.id);

    return res.redirect('/category/' + category);
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();
  res.render('admin', {
    categories,
    posts,
    isAdmin: true,
    error: '',
    success: ''
  });
});

app.post('/admin/posts', requireAdmin, (req, res) => {
  upload.single('media')(req, res, function(err) {
    const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();

    if (err) {
      return res.status(400).render('admin', {
        categories,
        posts,
        isAdmin: true,
        error: err.message || '업로드 중 오류가 발생했습니다.',
        success: ''
      });
    }

    const { category, title, content } = req.body;

    if (!category || !title || !content) {
      return res.status(400).render('admin', {
        categories,
        posts,
        isAdmin: true,
        error: '카테고리, 제목, 내용을 모두 입력해주세요.',
        success: ''
      });
    }

    const mediaPath = req.file ? `/uploads/${req.file.filename}` : '';
    const mediaType = req.file ? getMediaKind(req.file.mimetype) : '';

    db.prepare(`
      INSERT INTO posts (category, title, content, media_path, media_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(category, title.trim(), content.trim(), mediaPath, mediaType);

    return res.redirect('/category/' + category);
  });
});

app.post('/admin/posts/:id/delete', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);

  if (post) {
    if (post.media_path) {
      const filePath = path.join(publicDir, post.media_path.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    }
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    return res.redirect('/category/' + post.category);
  }

  return res.redirect('/admin');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('서버 오류가 발생했습니다.');
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
