require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const multer = require('multer');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const DEFAULT_SUPERADMIN_PASSWORD = 'muan0346';
const DEFAULT_EDITOR_PASSWORD = 'andkstj1!';

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
    author_id INTEGER,
    author_name TEXT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    media_path TEXT,
    media_type TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

try {
  db.exec(`ALTER TABLE posts ADD COLUMN author_id INTEGER;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE posts ADD COLUMN author_name TEXT;`);
} catch (e) {}

const superadminExists = db.prepare(
  `SELECT * FROM admins WHERE username = ?`
).get('superadmin');

if (!superadminExists) {
  const hash = bcrypt.hashSync(DEFAULT_SUPERADMIN_PASSWORD, 10);
  db.prepare(`
    INSERT INTO admins (username, password_hash, display_name, role)
    VALUES (?, ?, ?, ?)
  `).run('superadmin', hash, '범죄예방대응과', 'superadmin');
}

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

function deleteFileSafe(filePath) {
  if (!filePath) return;
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }
}

function transcodeVideoToMp4(inputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg 실행 파일을 찾을 수 없습니다.'));

    const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_ios.mp4';
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'main',
      '-level', '3.1',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = '';

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error('영상 자동 변환 실패: ' + stderr));
    });
  });
}


async function uploadFileToCloudinary(localPath, mediaType) {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary 환경변수가 설정되지 않았습니다.');
  }

  const options = {
    folder: 'muan-crime-guide',
    resource_type: mediaType === 'video' ? 'video' : 'image'
  };

  if (mediaType === 'video') {
    options.format = 'mp4';
    options.eager = [
      {
        format: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac'
      }
    ];
    options.eager_async = false;
  }

  const result = await cloudinary.uploader.upload(localPath, options);

  if (mediaType === 'video' && result.eager && result.eager.length > 0 && result.eager[0].secure_url) {
    return result.eager[0].secure_url;
  }

  return result.secure_url;
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

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  const admin = db.prepare(`
    SELECT * FROM admins
    WHERE username = ? AND is_active = 1
  `).get(username);

  if (!admin) {
    return res.render('login', {
      error: '아이디 또는 비밀번호가 올바르지 않습니다.',
      isAdmin: false
    });
  }

  const ok = bcrypt.compareSync(password, admin.password_hash);

  if (!ok) {
    return res.render('login', {
      error: '아이디 또는 비밀번호가 올바르지 않습니다.',
      isAdmin: false
    });
  }

  req.session.isAdmin = true;
  req.session.adminId = admin.id;
  req.session.adminRole = admin.role;
  req.session.adminName = admin.display_name;
  req.session.adminUsername = admin.username;

  return res.redirect('/admin');
});

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.adminRole === 'superadmin') {
    return next();
  }
  return res.status(403).send('권한이 없습니다.');
}

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
  upload.single('media')(req, res, async function(err) {
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
      deleteFileSafe(oldPath);
      mediaPath = '';
      mediaType = '';
    }

    if (req.file) {
      if (mediaPath) {
        const oldPath = path.join(publicDir, mediaPath.replace(/^\//, ''));
        deleteFileSafe(oldPath);
      }

      mediaPath = `/uploads/${req.file.filename}`;
      mediaType = getMediaKind(req.file.mimetype);

      try {
        mediaPath = await uploadFileToCloudinary(req.file.path, mediaType);
        deleteFileSafe(req.file.path);
      } catch (e) {
        deleteFileSafe(req.file.path);
        return res.status(400).render('edit', {
          post,
          categories,
          isAdmin: true,
          error: e.message || 'Cloudinary 업로드 중 오류가 발생했습니다.'
        });
      }
    }

    db.prepare(`
      UPDATE posts
      SET category = ?, title = ?, content = ?, media_path = ?, media_type = ?
      WHERE id = ?
    `).run(
  category,
  title.trim(),
  content.trim(),
  mediaPath,
  mediaType,
  req.session.adminId || null,
  req.session.adminName || '무안경찰서'
);
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
      INSERT INTO posts (category, title, content, media_path, media_type, author_id, author_name)
VALUES (?, ?, ?, ?, ?, ?, ?)
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
