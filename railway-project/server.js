// ════════════════════════════════════════════════════════════════════
// 모든에듀 학생부 분석기 server.js v25.1
// ────────────────────────────────────────────────────────────────────
// v25 → v25.1 변경사항:
// 1. Google Drive → Railway PostgreSQL로 변경
//    (서비스 계정 storage quota 문제 회피)
// 2. 영구 보존 + 빠른 검색 + 1만명+ 처리 가능
// 3. v25 프론트엔드와 100% 호환 (API 시그니처 동일)
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ══════════════════════════════════════════
// PostgreSQL 클라이언트 초기화
// ══════════════════════════════════════════
let pool = null;
let dbEnabled = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Railway는 SSL 필수
  });
  dbEnabled = true;
  console.log('✅ PostgreSQL 연결 활성화');
  console.log('   📊 DATABASE_URL: 등록됨');
} else {
  console.warn('⚠️ DATABASE_URL 없음 - 로컬 파일 모드로 fallback');
}

// ══════════════════════════════════════════
// 테이블 자동 생성 (서버 시작 시 1회)
// ══════════════════════════════════════════
async function initDatabase() {
  if (!dbEnabled) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id BIGINT PRIMARY KEY,
        date TEXT,
        name TEXT,
        major TEXT,
        curriculum TEXT,
        grades_avg TEXT,
        keywords JSONB,
        topics JSONB,
        activities JSONB,
        books JSONB,
        admitted TEXT,
        full_analysis JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_students_major ON students(major);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_students_admitted ON students(admitted);
    `);
    console.log('✅ students 테이블 준비 완료');
  } catch (e) {
    console.error('❌ 테이블 초기화 실패:', e.message);
    dbEnabled = false;
  }
}

// ══════════════════════════════════════════
// 로컬 파일 fallback
// ══════════════════════════════════════════
const LOCAL_DB_PATH = path.join(__dirname, 'students.json');

// ══════════════════════════════════════════
// 메모리 캐시 (5분 TTL)
// ══════════════════════════════════════════
let memCache = null;
let memCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ══════════════════════════════════════════
// DB I/O 통합 함수
// ══════════════════════════════════════════
async function loadDB() {
  // 캐시 hit
  if (memCache && Date.now() - memCacheTime < CACHE_TTL) {
    return memCache;
  }
  // PostgreSQL 시도
  if (dbEnabled) {
    try {
      const result = await pool.query(
        'SELECT * FROM students ORDER BY id ASC'
      );
      const students = result.rows.map(row => ({
        id: parseInt(row.id),
        date: row.date,
        name: row.name,
        major: row.major,
        curriculum: row.curriculum,
        grades_avg: row.grades_avg,
        keywords: row.keywords || [],
        topics: row.topics || [],
        activities: row.activities || [],
        books: row.books || [],
        admitted: row.admitted,
        full_analysis: row.full_analysis,
      }));
      memCache = students;
      memCacheTime = Date.now();
      return students;
    } catch (e) {
      console.error('❌ DB 읽기 실패:', e.message);
    }
  }
  // 로컬 fallback
  try {
    const localData = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
    memCache = localData;
    memCacheTime = Date.now();
    return localData;
  } catch {
    memCache = [];
    memCacheTime = Date.now();
    return [];
  }
}

async function insertStudent(student) {
  if (!dbEnabled) {
    const data = await loadDB();
    data.push(student);
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
    memCache = data;
    memCacheTime = Date.now();
    return { db: false, local: true };
  }
  try {
    await pool.query(
      `INSERT INTO students (id, date, name, major, curriculum, grades_avg, keywords, topics, activities, books, admitted, full_analysis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         major = EXCLUDED.major,
         curriculum = EXCLUDED.curriculum,
         grades_avg = EXCLUDED.grades_avg,
         keywords = EXCLUDED.keywords,
         topics = EXCLUDED.topics,
         activities = EXCLUDED.activities,
         books = EXCLUDED.books,
         admitted = EXCLUDED.admitted,
         full_analysis = EXCLUDED.full_analysis`,
      [
        student.id,
        student.date,
        student.name,
        student.major,
        student.curriculum,
        student.grades_avg,
        JSON.stringify(student.keywords || []),
        JSON.stringify(student.topics || []),
        JSON.stringify(student.activities || []),
        JSON.stringify(student.books || []),
        student.admitted,
        JSON.stringify(student.full_analysis || null),
      ]
    );
    memCache = null;
    console.log(`✅ 학생 저장 완료: ${student.name} (id: ${student.id})`);
    return { db: true, local: false };
  } catch (e) {
    console.error('❌ DB 쓰기 실패:');
    console.error('   메시지:', e.message);
    console.error('   코드:', e.code);
    return { db: false, local: false, error: e.message };
  }
}

async function updateStudent(id, updates) {
  if (!dbEnabled) {
    const data = await loadDB();
    const idx = data.findIndex(s => s.id === id);
    if (idx === -1) return false;
    data[idx] = { ...data[idx], ...updates };
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
    memCache = data;
    memCacheTime = Date.now();
    return true;
  }
  try {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [key, val] of Object.entries(updates)) {
      const isJson = ['keywords', 'topics', 'activities', 'books', 'full_analysis'].includes(key);
      fields.push(`${key} = $${i}`);
      values.push(isJson ? JSON.stringify(val) : val);
      i++;
    }
    values.push(id);
    await pool.query(
      `UPDATE students SET ${fields.join(', ')} WHERE id = $${i}`,
      values
    );
    memCache = null;
    return true;
  } catch (e) {
    console.error('❌ DB 업데이트 실패:', e.message);
    return false;
  }
}

async function deleteStudentById(id) {
  if (!dbEnabled) {
    const data = await loadDB();
    const idx = data.findIndex(s => s.id === id);
    if (idx === -1) return false;
    data.splice(idx, 1);
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
    memCache = data;
    memCacheTime = Date.now();
    return true;
  }
  try {
    const result = await pool.query('DELETE FROM students WHERE id = $1', [id]);
    memCache = null;
    return result.rowCount > 0;
  } catch (e) {
    console.error('❌ DB 삭제 실패:', e.message);
    return false;
  }
}

async function deleteAllStudents() {
  if (!dbEnabled) {
    fs.writeFileSync(LOCAL_DB_PATH, '[]');
    memCache = [];
    memCacheTime = Date.now();
    return true;
  }
  try {
    await pool.query('DELETE FROM students');
    memCache = [];
    memCacheTime = Date.now();
    return true;
  } catch (e) {
    console.error('❌ DB 전체 삭제 실패:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════
// Claude API 프록시 — 기존 유지
// ══════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'anthropic-beta': req.headers['anthropic-beta'] || 'pdfs-2024-09-25',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude API proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// 학생 데이터 API (PostgreSQL 버전)
// ══════════════════════════════════════════

app.post('/api/students', async (req, res) => {
  try {
    const student = {
      id: Date.now(),
      date: new Date().toISOString(),
      name: req.body.name || '이름없음',
      major: req.body.major || '',
      curriculum: req.body.curriculum || '',
      grades_avg: req.body.grades_avg || null,
      keywords: req.body.keywords || [],
      topics: req.body.topics || [],
      activities: req.body.activities || [],
      books: req.body.books || [],
      admitted: req.body.admitted || null,
      full_analysis: req.body.full_analysis || null,
    };
    const saveResult = await insertStudent(student);
    const all = await loadDB();
    res.json({
      ok: true,
      id: student.id,
      total: all.length,
      storage: saveResult,
    });
  } catch (e) {
    console.error('POST /api/students error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/students', async (req, res) => {
  try {
    const students = await loadDB();
    const { major, limit } = req.query;
    let result = students;
    if (major) {
      result = students.filter(
        (s) =>
          s.major &&
          (s.major.includes(major) || major.includes(s.major.slice(0, 3)))
      );
    }
    if (limit) result = result.slice(-parseInt(limit));
    res.json({ ok: true, students: result, total: students.length });
  } catch (e) {
    console.error('GET /api/students error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/students/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const success = await updateStudent(id, req.body);
    if (!success) return res.status(404).json({ ok: false });
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/students error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const success = await deleteStudentById(id);
    if (!success) return res.status(404).json({ ok: false });
    const all = await loadDB();
    res.json({ ok: true, total: all.length });
  } catch (e) {
    console.error('DELETE /api/students/:id error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/students', async (req, res) => {
  await deleteAllStudents();
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 헬스체크 & 진단
// ══════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const students = await loadDB();
    res.json({
      ok: true,
      version: 'v25.1',
      storage_type: dbEnabled ? 'PostgreSQL' : 'Local file (fallback)',
      database: {
        enabled: dbEnabled,
        connected: dbEnabled ? '✅' : '❌',
      },
      storage: {
        totalStudents: students.length,
        cacheActive: !!memCache,
        cacheAgeSeconds: memCache
          ? Math.floor((Date.now() - memCacheTime) / 1000)
          : null,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// SPA 라우팅
// ══════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ══════════════════════════════════════════
// 서버 시작
// ══════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`✅ 모든에듀 학생부 분석기 v25.1 실행 중: http://localhost:${PORT}`);
  await initDatabase();
  console.log(`   💾 저장소: ${dbEnabled ? 'PostgreSQL (영구 보존)' : '로컬 파일 (fallback)'}`);
});
