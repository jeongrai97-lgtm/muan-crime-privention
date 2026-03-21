require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
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
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-admin-password';

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

try {
  db.exec(`ALTER TABLE posts ADD COLUMN author_id INTEGER;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE posts ADD COLUMN author_name TEXT;`);
} catch (e) {}

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

const superadminHash = bcrypt.hashSync(DEFAULT_SUPERADMIN_PASSWORD, 10);

const superadminExists = db.prepare(
  `SELECT * FROM admins WHERE username = ?`
).get('superadmin');

if (!superadminExists) {
  db.prepare(`
    INSERT INTO admins (username, password_hash, display_name, role, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run('superadmin', superadminHash, '범죄예방대응과', 'superadmin');
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

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin || !req.session.adminId) {
    return res.status(403).send('권한이 없습니다.');
  }

  const admin = db.prepare(`
    SELECT * FROM admins
    WHERE id = ? AND is_active = 1
  `).get(req.session.adminId);

  if (!admin || admin.role !== 'superadmin') {
    return res.status(403).send('권한이 없습니다.');
  }

  return next();
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
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: __dirname,
    table: 'sessions'
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
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
  res.render('index', {
    categories,
    isAdmin: !!req.session.isAdmin,
    adminName: req.session.adminName || ''
  });
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

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/admin');

  const isSuperAdmin = req.session.adminRole === 'superadmin';
  const isAuthor = post.author_id && Number(post.author_id) === Number(req.session.adminId);

  if (!isSuperAdmin && !isAuthor) {
    return res.status(403).send('본인이 작성한 게시글만 수정할 수 있습니다.');
  }
  
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
    `).run(category, title.trim(), content.trim(), mediaPath, mediaType, req.params.id);

    return res.redirect('/category/' + category);
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();
  const admins = db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admins
    ORDER BY id ASC
  `).all();

  res.render('admin', {
    categories,
    posts,
    admins,
    isAdmin: true,
    isSuperAdmin: req.session.adminRole === 'superadmin',
    adminName: req.session.adminName || '',
    error: '',
    success: ''
  });
});

app.post('/admin/password', requireAdmin, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();
  const admins = db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admins
    ORDER BY id ASC
  `).all();

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '현재 비밀번호, 새 비밀번호, 새 비밀번호 확인을 모두 입력해주세요.',
      success: ''
    });
  }

  if (new_password !== confirm_password) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '새 비밀번호와 비밀번호 확인이 일치하지 않습니다.',
      success: ''
    });
  }

  if (new_password.length < 6) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '새 비밀번호는 6자 이상으로 입력해주세요.',
      success: ''
    });
  }

  const admin = db.prepare(`
    SELECT * FROM admins
    WHERE id = ? AND is_active = 1
  `).get(req.session.adminId);

  if (!admin) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '관리자 정보를 찾을 수 없습니다.',
      success: ''
    });
  }

  const ok = bcrypt.compareSync(current_password, admin.password_hash);

  if (!ok) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '현재 비밀번호가 올바르지 않습니다.',
      success: ''
    });
  }

  const newHash = bcrypt.hashSync(new_password, 10);

  db.prepare(`
    UPDATE admins
    SET password_hash = ?
    WHERE id = ?
  `).run(newHash, admin.id);

  return res.render('admin', {
    categories,
    posts,
    admins,
    isAdmin: true,
    isSuperAdmin: req.session.adminRole === 'superadmin',
    adminName: req.session.adminName || '',
    error: '',
    success: '비밀번호가 성공적으로 변경되었습니다.'
  });
});

app.post('/admin/users', requireSuperAdmin, (req, res) => {
  const { username, display_name } = req.body;
  const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();
  const admins = db.prepare(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admins
    ORDER BY id ASC
  `).all();

 if (!username || !display_name) {
    return res.status(400).render('admin', {
      categories,
      posts,
      admins,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '아이디와 닉네임을 모두 입력해주세요.',
      success: ''
    });
  }
    
  const exists = db.prepare(`
    SELECT * FROM admins
    WHERE username = ?
  `).get(username.trim());

  if (exists) {
    return res.status(400).render('admin', {
      categories,
      posts,
      isAdmin: true,
      isSuperAdmin: req.session.adminRole === 'superadmin',
      adminName: req.session.adminName || '',
      error: '이미 존재하는 관리자 아이디입니다.',
      success: ''
    });
  }

  const hash = bcrypt.hashSync(DEFAULT_EDITOR_PASSWORD, 10);

  db.prepare(`
    INSERT INTO admins (username, password_hash, display_name, role, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(
    username.trim(),
    hash,
    display_name.trim(),
    'editor'
  );

  return res.redirect('/admin');
});

app.post('/admin/users/:id/update', requireSuperAdmin, (req, res) => {
  const { display_name } = req.body;
  const id = req.params.id;

  if (!display_name || !display_name.trim()) {
    return res.redirect('/admin');
  }

  db.prepare(`
    UPDATE admins
    SET display_name = ?
    WHERE id = ? AND role != 'superadmin'
  `).run(display_name.trim(), id);

  return res.redirect('/admin');
});

app.post('/admin/users/:id/password-reset', requireSuperAdmin, (req, res) => {
  const id = req.params.id;

  const target = db.prepare(`
    SELECT * FROM admins
    WHERE id = ?
  `).get(id);

  if (!target || target.role === 'superadmin') {
    return res.redirect('/admin');
  }

  const hash = bcrypt.hashSync(DEFAULT_EDITOR_PASSWORD, 10);

  db.prepare(`
    UPDATE admins
    SET password_hash = ?
    WHERE id = ?
  `).run(hash, id);

  return res.redirect('/admin');
});

app.post('/admin/users/:id/toggle-active', requireSuperAdmin, (req, res) => {
  const id = req.params.id;

  const target = db.prepare(`
    SELECT * FROM admins
    WHERE id = ?
  `).get(id);

  if (!target || target.role === 'superadmin') {
    return res.redirect('/admin');
  }

  const nextValue = target.is_active ? 0 : 1;

  db.prepare(`
    UPDATE admins
    SET is_active = ?
    WHERE id = ?
  `).run(nextValue, id);

  return res.redirect('/admin');
});

app.post('/admin/posts', requireAdmin, (req, res) => {
  upload.single('media')(req, res, async function(err) {
    const posts = db.prepare(`SELECT * FROM posts ORDER BY id DESC`).all();
    const admins = db.prepare(`
      SELECT id, username, display_name, role, is_active, created_at
      FROM admins
      ORDER BY id ASC
    `).all();

    if (err) {
      return res.status(400).render('admin', {
        categories,
        posts,
        admins,
        isAdmin: true,
        isSuperAdmin: req.session.adminRole === 'superadmin',
        adminName: req.session.adminName || '',
        error: err.message || '업로드 중 오류가 발생했습니다.',
        success: ''
      });
    }

    const { category, title, content } = req.body;

    if (!category || !title || !content) {
      return res.status(400).render('admin', {
        categories,
        posts,
        admins,
        isAdmin: true,
        isSuperAdmin: req.session.adminRole === 'superadmin',
        adminName: req.session.adminName || '',
        error: '카테고리, 제목, 내용을 모두 입력해주세요.',
        success: ''
      });
    }

    let mediaPath = '';
    let mediaType = '';

    if (req.file) {
      mediaType = getMediaKind(req.file.mimetype);

      try {
        mediaPath = await uploadFileToCloudinary(req.file.path, mediaType);
        deleteFileSafe(req.file.path);
      } catch (e) {
        deleteFileSafe(req.file.path);
        return res.status(400).render('admin', {
          categories,
          posts,
          admins,
          isAdmin: true,
          isSuperAdmin: req.session.adminRole === 'superadmin',
          adminName: req.session.adminName || '',
          error: e.message || 'Cloudinary 업로드 중 오류가 발생했습니다.',
          success: ''
        });
      }
    }

    db.prepare(`
      INSERT INTO posts (category, title, content, media_path, media_type, author_id, author_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('서버 오류가 발생했습니다.');
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
