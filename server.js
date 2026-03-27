require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const multer = require('multer');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const { v2: cloudinary } = require('cloudinary');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/practice-112', (req, res) => {
  res.render('112_practice');
});

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER,
      author_name TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      media_path TEXT,
      media_type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_images (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function bootstrap() {
  await initDb();
  await seedInitialData();
}

bootstrap().catch(err => {
  console.error('DB 초기화 오류:', err);
});

const superadminHash = bcrypt.hashSync(DEFAULT_SUPERADMIN_PASSWORD, 10);

async function seedInitialData() {
  const superadminExists = await pool.query(
    `SELECT * FROM admins WHERE username = $1`,
    ['superadmin']
  );

  if (superadminExists.rows.length === 0) {
    await pool.query(
      `INSERT INTO admins (username, password_hash, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, 1)`,
      ['superadmin', superadminHash, '범죄예방대응과', 'superadmin']
    );
  }

  // 기존 카테고리 구조를 최신 구조로 자동 정리
  await pool.query(`
    UPDATE posts SET category = '__tmp_foreign__' WHERE category = 'foreign';
  `);

  await pool.query(`
    UPDATE posts SET category = 'foreign' WHERE category = 'phishing';
  `);

  await pool.query(`
    UPDATE posts SET category = 'notice' WHERE category = '__tmp_foreign__';
  `);
}

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

async function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin || !req.session.adminId) {
    return res.status(403).send('권한이 없습니다.');
  }

  const result = await pool.query(
    `SELECT * FROM admins WHERE id = $1 AND is_active = 1`,
    [req.session.adminId]
  );

  const admin = result.rows[0];

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

app.get('/category/:category', async (req, res) => {
  const info = categoryInfo(req.params.category);
  if (!info) return res.status(404).send('존재하지 않는 카테고리입니다.');

  const result = await pool.query(
    `SELECT * FROM posts WHERE category = $1 ORDER BY id DESC`,
    [req.params.category]
  );

  const posts = result.rows;

  for (const post of posts) {
    const imageResult = await pool.query(
      `SELECT image_path FROM post_images WHERE post_id = $1 ORDER BY id ASC`,
      [post.id]
    );
    post.images = imageResult.rows.map(row => row.image_path);
  }

  res.render('category', {
    info,
    posts,
    isAdmin: !!req.session.isAdmin,
    adminId: req.session.adminId || null,
    adminRole: req.session.adminRole || ''
  });
});

app.get('/admin/login', (req, res) => {
  res.render('login', { error: '', isAdmin: !!req.session.isAdmin });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    `SELECT * FROM admins WHERE username = $1 AND is_active = 1`,
    [username]
  );

  const admin = result.rows[0];

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

app.get('/admin/posts/:id/edit', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM posts WHERE id = $1',
    [req.params.id]
  );

  const post = result.rows[0];
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
  upload.array('media', 10)(req, res, async function(err) {
    const result = await pool.query(
      'SELECT * FROM posts WHERE id = $1',
      [req.params.id]
    );

    const post = result.rows[0];
    if (!post) return res.redirect('/admin');

    const isSuperAdmin = req.session.adminRole === 'superadmin';
    const isAuthor = post.author_id && Number(post.author_id) === Number(req.session.adminId);

    if (!isSuperAdmin && !isAuthor) {
      return res.status(403).send('본인이 작성한 게시글만 수정할 수 있습니다.');
    }

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
      const oldPath = path.join(publicDir, String(mediaPath).replace(/^\//, ''));
      deleteFileSafe(oldPath);
      mediaPath = '';
      mediaType = '';
    }

    if (req.file) {
      if (mediaPath && !String(mediaPath).includes('res.cloudinary.com')) {
        const oldPath = path.join(publicDir, String(mediaPath).replace(/^\//, ''));
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

    await pool.query(
      `UPDATE posts
       SET category = $1, title = $2, content = $3, media_path = $4, media_type = $5
       WHERE id = $6`,
      [
        category,
        title.trim(),
        content.trim(),
        mediaPath,
        mediaType,
        req.params.id
      ]
    );

    return res.redirect('/category/' + category);
  });
});

app.post('/admin/posts/:id/delete', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM posts WHERE id = $1',
    [req.params.id]
  );

  const post = result.rows[0];

  if (!post) return res.redirect('/admin');

  const isSuperAdmin = req.session.adminRole === 'superadmin';
  const isAuthor = post.author_id && Number(post.author_id) === Number(req.session.adminId);

  if (!isSuperAdmin && !isAuthor) {
    return res.status(403).send('본인이 작성한 게시글만 삭제할 수 있습니다.');
  }

  if (post.media_path && !String(post.media_path).includes('res.cloudinary.com')) {
    const filePath = path.join(publicDir, String(post.media_path).replace(/^\//, ''));
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }

  await pool.query(
    'DELETE FROM posts WHERE id = $1',
    [req.params.id]
  );

  return res.redirect('/category/' + post.category);
});

app.get('/admin', requireAdmin, async (req, res) => {
  const postsResult = await pool.query(`SELECT * FROM posts ORDER BY id DESC`);
  const adminsResult = await pool.query(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admins
    ORDER BY id ASC
  `);

  res.render('admin', {
    categories,
    posts: postsResult.rows,
    admins: adminsResult.rows,
    isAdmin: true,
    isSuperAdmin: req.session.adminRole === 'superadmin',
    adminName: req.session.adminName || '',
    error: '',
    success: ''
  });
});

app.get('/admin/posts/new', requireAdmin, (req, res) => {
  res.render('new-post', {
    categories,
    isAdmin: true,
    error: '',
    adminName: req.session.adminName || '',
    isSuperAdmin: req.session.adminRole === 'superadmin'
  });
});

app.post('/admin/password', requireAdmin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  const postsResult = await pool.query(`SELECT * FROM posts ORDER BY id DESC`);
  const adminsResult = await pool.query(`
    SELECT id, username, display_name, role, is_active, created_at
    FROM admins
    ORDER BY id ASC
  `);

  const posts = postsResult.rows;
  const admins = adminsResult.rows;

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

  const adminResult = await pool.query(
    `SELECT * FROM admins WHERE id = $1 AND is_active = 1`,
    [req.session.adminId]
  );

  const admin = adminResult.rows[0];

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

  await pool.query(
    `UPDATE admins SET password_hash = $1 WHERE id = $2`,
    [newHash, admin.id]
  );

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

app.post('/admin/users/:id/password-reset', requireSuperAdmin, async (req, res) => {
  const id = req.params.id;

  const targetResult = await pool.query(
    `SELECT * FROM admins WHERE id = $1`,
    [id]
  );

  const target = targetResult.rows[0];

  if (!target || target.role === 'superadmin') {
    return res.redirect('/admin');
  }

  const hash = bcrypt.hashSync(DEFAULT_EDITOR_PASSWORD, 10);

  await pool.query(
    `UPDATE admins SET password_hash = $1 WHERE id = $2`,
    [hash, id]
  );

  return res.redirect('/admin');
});

app.post('/admin/posts', requireAdmin, (req, res) => {
  upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'video', maxCount: 1 }
  ])(req, res, async function(err) {
    try {
    const postsResult = await pool.query(`SELECT * FROM posts ORDER BY id DESC`);
    const adminsResult = await pool.query(`
      SELECT id, username, display_name, role, is_active, created_at
      FROM admins
      ORDER BY id ASC
    `);

    const posts = postsResult.rows;
    const admins = adminsResult.rows;

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

app.post('/admin/posts', requireAdmin, (req, res) => {
  upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'video', maxCount: 1 }
  ])(req, res, async function(err) {
    try {
      const postsResult = await pool.query(`SELECT * FROM posts ORDER BY id DESC`);
      const adminsResult = await pool.query(`
        SELECT id, username, display_name, role, is_active, created_at
        FROM admins
        ORDER BY id ASC
      `);

      const posts = postsResult.rows;
      const admins = adminsResult.rows;

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

      const imageFiles = (req.files && req.files.images) ? req.files.images : [];
      const videoFiles = (req.files && req.files.video) ? req.files.video : [];

      let mediaPath = '';
      let mediaType = '';
      let uploadedImages = [];

      if (videoFiles.length > 0) {
        const videoFile = videoFiles[0];

        try {
          mediaPath = await uploadFileToCloudinary(videoFile.path, 'video');
          mediaType = 'video';
          deleteFileSafe(videoFile.path);
        } catch (e) {
          deleteFileSafe(videoFile.path);
          return res.status(400).render('admin', {
            categories,
            posts,
            admins,
            isAdmin: true,
            isSuperAdmin: req.session.adminRole === 'superadmin',
            adminName: req.session.adminName || '',
            error: e.message || '영상 업로드 중 오류가 발생했습니다.',
            success: ''
          });
        }
      }

      for (const file of imageFiles) {
        try {
          const imageUrl = await uploadFileToCloudinary(file.path, 'image');
          uploadedImages.push(imageUrl);
          deleteFileSafe(file.path);
        } catch (e) {
          deleteFileSafe(file.path);
          return res.status(400).render('admin', {
            categories,
            posts,
            admins,
            isAdmin: true,
            isSuperAdmin: req.session.adminRole === 'superadmin',
            adminName: req.session.adminName || '',
            error: e.message || '사진 업로드 중 오류가 발생했습니다.',
            success: ''
          });
        }
      }

      if (!mediaPath && uploadedImages.length > 0) {
        mediaPath = uploadedImages[0];
        mediaType = 'image';
      }

      const insertResult = await pool.query(
        `INSERT INTO posts (category, title, content, media_path, media_type, author_id, author_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          category,
          title.trim(),
          content.trim(),
          mediaPath,
          mediaType,
          req.session.adminId || null,
          req.session.adminName || '무안경찰서'
        ]
      );

      const postId = insertResult.rows[0].id;

      for (const imagePath of uploadedImages) {
        await pool.query(
          `INSERT INTO post_images (post_id, image_path)
           VALUES ($1, $2)`,
          [postId, imagePath]
        );
      }

      return res.redirect('/category/' + category);
    } catch (e) {
      console.error('게시글 등록 오류:', e);
      return res.status(500).send('게시글 등록 중 서버 오류가 발생했습니다.');
    }
  });
});

    await pool.query(
      `INSERT INTO posts (category, title, content, media_path, media_type, author_id, author_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        category,
        title.trim(),
        content.trim(),
        mediaPath,
        mediaType,
        req.session.adminId || null,
        req.session.adminName || '무안경찰서'
      ]
    );

    return res.redirect('/category/' + category);
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('서버 오류가 발생했습니다.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
