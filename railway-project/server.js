// ════════════════════════════════════════════════════════════════════
// 모든에듀 학생부 분석기 server.js v25
// ────────────────────────────────────────────────────────────────────
// v24 → v25 변경사항:
// 1. Google Drive 백엔드 저장소 통합 (영구 보관)
// 2. 메모리 캐시 (5분 TTL) — Drive 호출 최소화
// 3. 로컬 파일 fallback (Drive 실패 시 자동 전환)
// 4. 기존 API 시그니처 100% 호환 (프론트엔드 변경 불필요)
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ══════════════════════════════════════════
// Google Drive 클라이언트 초기화
// ══════════════════════════════════════════
let drive = null;
let driveEnabled = false;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
const DB_FILENAME = 'students.json';
let cachedFileId = null; // students.json 파일의 Drive ID 캐시

try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY && DRIVE_FOLDER_ID) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    drive = google.drive({ version: 'v3', auth });
    driveEnabled = true;
    console.log('✅ Google Drive 연동 활성화');
    console.log('   📁 폴더 ID:', DRIVE_FOLDER_ID);
    console.log('   🤖 서비스 계정:', credentials.client_email);
  } else {
    console.warn('⚠️ Google Drive 비활성화 (환경변수 없음) - 로컬 파일 모드로 동작');
  }
} catch (e) {
  console.error('❌ Google Drive 초기화 실패:', e.message);
  console.warn('   → 로컬 파일 모드로 fallback');
}

// ══════════════════════════════════════════
// 로컬 파일 fallback 경로
// ══════════════════════════════════════════
const LOCAL_DB_PATH = path.join(__dirname, 'students.json');

// ══════════════════════════════════════════
// 메모리 캐시 (5분 TTL)
// ══════════════════════════════════════════
let memCache = null;
let memCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5분

// ══════════════════════════════════════════
// Drive 파일 ID 검색 (students.json)
// ══════════════════════════════════════════
async function findDriveFileId() {
  if (cachedFileId) return cachedFileId;
  try {
    const res = await drive.files.list({
      q: `name='${DB_FILENAME}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });
    if (res.data.files.length > 0) {
      cachedFileId = res.data.files[0].id;
      return cachedFileId;
    }
    return null;
  } catch (e) {
    console.error('Drive 파일 검색 실패:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════
// Drive에서 students.json 읽기
// ══════════════════════════════════════════
async function loadFromDrive() {
  if (!driveEnabled) return null;
  try {
    const fileId = await findDriveFileId();
    if (!fileId) {
      console.log('📭 Drive에 students.json 없음 → 빈 배열 반환');
      return [];
    }
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Drive 읽기 실패:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════
// Drive에 students.json 쓰기 (생성 or 업데이트)
// ══════════════════════════════════════════
async function saveToDrive(data) {
  if (!driveEnabled) return false;
  try {
    const content = JSON.stringify(data, null, 2);
    const fileId = await findDriveFileId();
    const media = {
      mimeType: 'application/json',
      body: Readable.from([content]),
    };
    if (fileId) {
      // 업데이트
      await drive.files.update({ fileId, media });
    } else {
      // 새로 생성
      const res = await drive.files.create({
        requestBody: {
          name: DB_FILENAME,
          parents: [DRIVE_FOLDER_ID],
          mimeType: 'application/json',
        },
        media,
        fields: 'id',
      });
      cachedFileId = res.data.id;
    }
    return true;
  } catch (e) {
    console.error('Drive 쓰기 실패:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════
// 통합 DB I/O (Drive 우선, 로컬 fallback)
// ══════════════════════════════════════════
async function loadDB() {
  // 캐시 hit
  if (memCache && Date.now() - memCacheTime < CACHE_TTL) {
    return memCache;
  }
  // Drive 시도
  if (driveEnabled) {
    const driveData = await loadFromDrive();
    if (driveData !== null) {
      memCache = driveData;
      memCacheTime = Date.now();
      return driveData;
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

async function saveDB(data) {
  // 캐시 즉시 갱신
  memCache = data;
  memCacheTime = Date.now();
  // Drive 저장 시도
  let driveSuccess = false;
  if (driveEnabled) {
    driveSuccess = await saveToDrive(data);
  }
  // 로컬에도 백업 (fallback)
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('로컬 백업 실패:', e.message);
  }
  return { drive: driveSuccess, local: true };
}

// ══════════════════════════════════════════
// Claude API 프록시 (CORS 우회) — 기존 그대로
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
// 학생 데이터 API (Drive 통합 버전)
// ══════════════════════════════════════════

// 학생 데이터 저장
app.post('/api/students', async (req, res) => {
  try {
    const students = await loadDB();
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
    };
    students.push(student);
    const saveResult = await saveDB(students);
    res.json({
      ok: true,
      id: student.id,
      total: students.length,
      storage: saveResult,
    });
  } catch (e) {
    console.error('POST /api/students error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 전체 학생 목록 조회 (전공 필터 가능)
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

// 합격여부 업데이트 (또는 다른 필드)
app.patch('/api/students/:id', async (req, res) => {
  try {
    const students = await loadDB();
    const idx = students.findIndex((s) => s.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ ok: false });
    students[idx] = { ...students[idx], ...req.body };
    await saveDB(students);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/students error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 단일 학생 삭제 (신규)
app.delete('/api/students/:id', async (req, res) => {
  try {
    const students = await loadDB();
    const idx = students.findIndex((s) => s.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ ok: false });
    students.splice(idx, 1);
    await saveDB(students);
    res.json({ ok: true, total: students.length });
  } catch (e) {
    console.error('DELETE /api/students/:id error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 전체 삭제 (관리용)
app.delete('/api/students', async (req, res) => {
  await saveDB([]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 헬스체크 & 진단 엔드포인트 (신규)
// ══════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const students = await loadDB();
    res.json({
      ok: true,
      version: 'v25',
      drive: {
        enabled: driveEnabled,
        folderId: DRIVE_FOLDER_ID
          ? DRIVE_FOLDER_ID.slice(0, 8) + '...'
          : null,
        fileId: cachedFileId
          ? cachedFileId.slice(0, 8) + '...'
          : null,
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
// SPA 라우팅 (React 앱)
// ══════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 모든에듀 학생부 분석기 v25 실행 중: http://localhost:${PORT}`);
  console.log(`   💾 저장소: ${driveEnabled ? 'Google Drive + 로컬 백업' : '로컬 파일 only'}`);
});
