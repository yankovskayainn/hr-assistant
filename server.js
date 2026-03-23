require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const pdf     = require('pdf-parse');
const mammoth = require('mammoth');

const app  = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '20');
const MAX_POLICIES     = parseInt(process.env.MAX_POLICIES     || '20');
const TEAM_PASSWORD    = process.env.TEAM_PASSWORD || '';
const API_KEY          = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
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

const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { policies: [], messages: [] });
  return sessions.get(id);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['.pdf', '.docx', '.doc', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type: ' + ext));
  }
});

async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') {
    const data = await pdf(file.buffer);
    return data.text;
  }
  if (ext === '.docx' || ext === '.doc') {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value;
  }
  return file.buffer.toString('utf-8');
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/policies', authGuard, upload.array('files', MAX_POLICIES), async (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const session   = getSession(sessionId);
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded' });
  const added = [];
  const errors = [];
  for (const file of req.files) {
    try {
      const text = await extractText(file);
      session.policies.push({ name: file.originalname, size: file.size, text });
      added.push({ name: file.originalname, size: file.size, chars: text.length });
    } catch (e) {
      errors.push({ name: file.originalname, error: e.message });
    }
  }
  res.json({ added, errors, total: session.policies.length });
});

app.get('/api/policies', authGuard, (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const session   = getSession(sessionId);
  res.json(session.policies.map(p => ({ name: p.name, size: p.size, chars: p.text.length })));
});

app.delete('/api/policies/:index', authGuard, (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const session   = getSession(sessionId);
  const idx       = parseInt(req.params.index);
  if (idx < 0 || idx >= session.policies.length)
    return res.status(404).json({ error: 'Policy not found' });
  const removed = session.policies.splice(idx, 1)[0];
  res.json({ removed: removed.name, total: session.policies.length });
});

app.delete('/api/policies', authGuard, (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const session   = getSession(sessionId);
  session.policies = [];
  session.messages = [];
  res.json({ cleared: true });
});

const SYSTEM_PROMPT = `You are Alex, a senior HR Business Partner with 15+ years of experience. You are the HR expert — you speak in first person, never referring to HR as if it were a separate department.

Always base your answers strictly on the policy documents provided. Never invent rules. If a situation is not covered by any policy, say: "This isn't directly addressed in our current policies. I'd recommend escalating this to the HR Director or Legal team." Respond in the same language the person writes to you. Tone: professional, warm, and clear — never robotic.

When answering a policy question, always respond in three clearly labelled parts:

Part 1 — HR Advisor Note:
Answer directly and confidently in first person. Explain the situation, your interpretation, and any recommended action. Always cite the exact policy and section.
📌 Policy reference: [Policy name — Section number: clause or summary]

Part 2 — Formal Email to Employee:
Write a professional, warm, empathetic email ready to send directly to the employee. This email must:
- Explain the situation in plain, human language the employee can easily understand
- Give enough information so the employee knows where they stand and what happens next
- Sound natural and personal — not like a policy document
- Never mention policy names, section numbers, or clause references
- End with an invitation to ask further questions

Part 3 — Informal Note from Alex:
Write a short friendly message as if you are Alex speaking directly to the employee in a casual human way. This should:
- Feel like it is coming from a real person who genuinely cares
- Use simple everyday language — warm, conversational, no formality
- Briefly reassure the employee and let them know you are available to talk
- Be short — 3 to 5 sentences maximum
- Never mention policy names, section numbers, or clause references`;

app.post('/api/chat', authGuard, async (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'default';
  const session   = getSession(sessionId);
  const { message, mode = 'question', history = [] } = req.body;

  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message is required' });

  const policyContext = session.policies.length > 0
    ? '\n\n--- COMPANY HR POLICIES ---\n' +
      session.policies.map(p => `\n[DOCUMENT: ${p.name}]\n${p.text}`).join('\n\n')
    : '\n\n[No HR policy documents loaded. Provide general HR best-practice guidance and clearly state this is not company-specific.]';

  const systemWithPolicies = SYSTEM_PROMPT + policyContext;

  const modePrefix = mode === 'email'
    ? 'The following is a staff email. Please draft a professional HR reply with policy references:\n\n'
    : '';

  const trimmedHistory = history.slice(-20);
  const messages = [
    ...trimmedHistory,
    { role: 'user', content: modePrefix + message }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemWithPolicies,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error('Anthropic error: ' + errText);
    }

    const data  = await response.json();
    const reply = data.content?.map(b => b.text || '').join('') || '';

    res.json({
      reply,
      model: data.model,
      usage: data.usage || {},
      policiesLoaded: session.policies.length
    });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HR Assistant running on port ${PORT}`);
});
