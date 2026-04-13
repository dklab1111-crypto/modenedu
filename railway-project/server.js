// ══════════════════════════════════════════
// server.js 에 추가할 코드 (기존 코드 뒤에 붙이기)
// ══════════════════════════════════════════
const fs = require('fs');
const path = require('path');
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
      admitted: req.body.admitted || null  // 나중에 합격여부 입력용
    };
    students.push(student);
    saveDB(students);
    res.json({ ok: true, id: student.id, total: students.length });
  } catch(e) {
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
        s.major && (s.major.includes(major) || major.includes(s.major.slice(0,3)))
      );
    }
    if (limit) result = result.slice(-parseInt(limit)); // 최근 N개
    res.json({ ok: true, students: result, total: students.length });
  } catch(e) {
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
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 전체 삭제 (관리용)
app.delete('/api/students', (req, res) => {
  saveDB([]);
  res.json({ ok: true });
});
