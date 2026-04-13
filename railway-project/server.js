const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════
// Claude API 프록시 (CORS 우회)
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
// 학생 데이터 DB (students.json)
// ══════════════════════════════════════════
const DB_PATH = path.join(__dirname, 'students.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return []; }
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// 학생 데이터 저장
app.post('/api/students', (req, res) => {
  try {
    const students = loadDB();
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
      admitted: req.body.admitted || null
    };
    students.push(student);
    saveDB(students);
    res.json({ ok: true, id: student.id, total: students.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 전체 학생 목록 조회 (전공 필터 가능)
app.get('/api/students', (req, res) => {
  try {
    const students = loadDB();
    const { major, limit } = req.query;
    let result = students;
    if (major) {
      result = students.filter(s =>
        s.major && (s.major.includes(major) || major.includes(s.major.slice(0, 3)))
      );
    }
    if (limit) result = result.slice(-parseInt(limit));
    res.json({ ok: true, students: result, total: students.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 합격여부 업데이트
app.patch('/api/students/:id', (req, res) => {
  try {
    const students = loadDB();
    const idx = students.findIndex(s => s.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ ok: false });
    students[idx] = { ...students[idx], ...req.body };
    saveDB(students);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 전체 삭제 (관리용)
app.delete('/api/students', (req, res) => {
  saveDB([]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// SPA 라우팅 (React 앱)
// ══════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 모든에듀 서버 실행 중: http://localhost:${PORT}`);
});
