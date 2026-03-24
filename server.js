require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fetch    = require('node-fetch');
const pdf      = require('pdf-parse');
const mammoth  = require('mammoth');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || '';
const API_KEY       = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS policies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER,
      content TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authGuard(req, res, next) {
  if (!TEAM_PASSWORD) return next();
  const token = req.headers['x-team-password'] || req.query.password;
  if (token !== TEAM_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.pdf','.docx','.doc','.txt'].includes(ext) ? cb(null,true) : cb(new Error('Unsupported file type'));
  }
});

async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') { const d = await pdf(file.buffer); return d.text; }
  if (ext === '.docx' || ext === '.doc') { const { value } = await mammoth.extractRawText({ buffer: file.buffer }); return value; }
  return file.buffer.toString('utf-8');
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/policies', authGuard, upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const added = [], errors = [];
  for (const file of req.files) {
    try {
      const text = await extractText(file);
      await pool.query('INSERT INTO policies (name, size, content) VALUES ($1, $2, $3)', [file.originalname, file.size, text]);
      added.push({ name: file.originalname, size: file.size, chars: text.length });
    } catch(e) { errors.push({ name: file.originalname, error: e.message }); }
  }
  const total = (await pool.query('SELECT COUNT(*) FROM policies')).rows[0].count;
  res.json({ added, errors, total: parseInt(total) });
});

app.get('/api/policies', authGuard, async (req, res) => {
  const result = await pool.query('SELECT id, name, size, length(content) as chars FROM policies ORDER BY created_at');
  res.json(result.rows);
});

app.delete('/api/policies/:id', authGuard, async (req, res) => {
  await pool.query('DELETE FROM policies WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

app.delete('/api/policies', authGuard, async (req, res) => {
  await pool.query('DELETE FROM policies');
  res.json({ cleared: true });
});

const SYSTEM_PROMPT = `You are Alex, a senior HR Business Partner with 15+ years of experience. You are the HR expert — you speak in first person, never referring to HR as if it were a separate department.

Always base your answers strictly on the policy documents provided. Never invent rules. If a situation is not covered by any policy, say: "This isn't directly addressed in our current policies. I'd recommend escalating this to the HR Director or Legal team." Respond in the same language the person writes to you. Tone: professional, warm, and clear — never robotic.

When answering a policy question, always respond in three clearly labelled parts:

Part 1 — HR Advisor Note:
Answer directly and confidently in first person. Explain the situation, your interpretation, and any recommended action. Always cite the exact policy and section.
📌 Policy reference: [Policy name — Section number: clause or summary]

Part 2 — Formal Email to Employee:
Write a professional, warm, empathetic email ready to send directly to the employee. This email must explain the situation in plain human language, never mention policy names or section numbers, and end with an invitation to ask further questions.

Part 3 — Informal Note from Alex:
Write a short friendly message as if you are Alex speaking directly to the employee in a casual human way. 3 to 5 sentences maximum. Never mention policy names or section numbers.`;

app.post('/api/chat', authGuard, async (req, res) => {
  const { message, mode = 'question', history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const policiesResult = await pool.query('SELECT name, content FROM policies ORDER BY created_at');
  const policyContext = policiesResult.rows.length > 0
    ? '\n\n--- COMPANY HR POLICIES ---\n' + policiesResult.rows.map(p => `\n[DOCUMENT: ${p.name}]\n${p.content.substring(0, 8000)}`).join('\n\n')
    : '\n\n[No HR policy documents loaded. Provide general HR best-practice guidance and clearly state this is not company-specific.]';

  const systemWithPolicies = SYSTEM_PROMPT + policyContext;
  const modePrefix = mode === 'email' ? 'The following is a staff email. Please reply as Alex with all three parts:\n\n' : '';
  const messages = [...history.slice(-20), { role: 'user', content: modePrefix + message }];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: systemWithPolicies, messages })
    });
    if (!response.ok) { const t = await response.text(); throw new Error(t); }
    const data  = await response.json();
    const reply = data.content?.map(b => b.text || '').join('') || '';
    res.json({ reply, policiesLoaded: policiesResult.rows.length });
  } catch(err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`HR Assistant running on port ${PORT}`));
});
