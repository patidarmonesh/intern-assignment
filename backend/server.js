import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3001;

// Groq OpenAI-compatible config
const LLM_BASE = process.env.LLM_BASE || 'https://api.groq.com/openai/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : [CORS_ORIGIN], credentials: true }));
app.use(express.json());

// In-memory store
const questions = [];
const answers = [];
const clients = [];

// SSE helpers
function openSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN
  });
  if (res.flushHeaders) res.flushHeaders();
}
function broadcast(event, data) {
  clients.forEach(c => {
    try {
      c.res.write(`event: ${event}\n`);
      c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  });
}

// Concise prompts for speed and stability
function promptText(q) {
  return `
Return ONLY the explanation text (5–8 sentences). No JSON/code.
- Clear, concise, correct. Define 1–2 key terms. Max ~160 words.
Question: ${q}
`.trim();
}
function promptViz(q) {
  return `
Return ONLY JSON:

{
  "text": "1–2 sentence caption",
  "visualization": {
    "id": "vis_<ts>",
    "duration": 6500 to 9500,
    "fps": 30,
    "layers": [
      {
        "id": "unique",
        "type": "circle|rectangle|arrow|text|line",
        "props": { "x": <num>, "y": <num>, "r": <num>, "width": <num>, "height": <num>, "fill": <str>, "stroke": <str>, "strokeWidth": <num>, "color": <str>, "font": <str>, "text": <str>, "opacity": <0..1>, "textAlign": "left|center|right", "textBaseline": "top|middle|bottom" },
        "animations": [
          { "property": "x|y|r|width|height|opacity|orbit", "from": <num|null>, "to": <num|null>, "start": <ms>, "end": <ms>, "easing": "linear|ease-in|ease-out|ease-in-out", "centerX": <num?>, "centerY": <num?>, "radius": <num?> }
        ]
      }
    ]
  }
}

Rules:
- Canvas 700x450. Use 3–5 layers total.
- Use arrows for forces/flows; orbit for circular motion; short title text near top.
Question: ${q}
`.trim();
}

// Generic reader for Groq streaming (OpenAI-compatible SSE deltas)
async function readGroqStream(response, onDelta) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = processBuffer(buffer, onDelta);
    }
  } else {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk);
      buffer = processBuffer(buffer, onDelta);
    }
  }
}
function processBuffer(buffer, onDelta) {
  const parts = buffer.split('\n\n');
  buffer = parts.pop() || '';
  for (const part of parts) {
    if (!part.startsWith('data:')) continue;
    const json = part.replace(/^data:\s*/, '').trim();
    if (json === '[DONE]') continue;
    try {
      const obj = JSON.parse(json);
      const delta = obj.choices?.[0]?.delta?.content || '';
      if (delta) onDelta(delta);
    } catch {}
  }
  return buffer;
}

// Groq calls
async function groqStreamText(question, onChunk) {
  const url = `${LLM_BASE}/chat/completions`;
  const system = "Return ONLY the explanation text. No JSON.";
  const user = promptText(question);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.15,
      stream: true,
      max_tokens: 380
    })
  });
  if (!resp.ok) throw new Error(`Groq stream ${resp.status}: ${await resp.text()}`);
  await readGroqStream(resp, onChunk);
}

async function groqVizJSON(question) {
  const url = `${LLM_BASE}/chat/completions`;
  const system = "Return ONLY valid JSON as specified. No extra text.";
  const user = promptViz(question);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.15,
      stream: false,
      max_tokens: 480
    })
  });
  if (!resp.ok) throw new Error(`Groq viz ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const match = raw.match(/\{[\s\S]*\}$/);
  let parsed;
  try { parsed = JSON.parse(match ? match[0] : raw); }
  catch {
    parsed = { text: "Visualization", visualization: { id: `vis_${Date.now()}`, duration: 8000, fps: 30, layers: [] } };
  }
  const v = parsed.visualization || {};
  parsed.visualization = {
    id: v.id || `vis_${Date.now()}`,
    duration: v.duration || 8000,
    fps: v.fps || 30,
    layers: Array.isArray(v.layers) ? v.layers : []
  };
  return parsed;
}

// API
app.post('/api/questions', async (req, res) => {
  try {
    const { userId, question } = req.body;
    if (!userId || !question) return res.status(400).json({ error: 'Missing userId or question' });

    const questionId = `q_${uuidv4()}`;
    const answerId = `a_${uuidv4()}`;
    const qrec = { id: questionId, userId, question: question.trim(), answerId, timestamp: new Date().toISOString() };
    questions.push(qrec);
    broadcast('question_created', qrec);

    // let UI show “in progress”
    broadcast('generation_started', { id: answerId, questionId });

    // stream text first
    let text = '';
    await groqStreamText(question, (delta) => {
      text += delta;
      broadcast('answer_partial', { id: answerId, textPartial: text, questionId });
    });

    // then JSON viz
    const viz = await groqVizJSON(question);
    const ans = { id: answerId, text, visualization: viz.visualization, timestamp: new Date().toISOString() };
    answers.push(ans);
    broadcast('answer_created', ans);

    res.json({ success: true, questionId, answerId });
  } catch (e) {
    console.error('LLM error', e);
    const fallback = {
      id: `a_${uuidv4()}`,
      text: `Here is a brief overview of "${req.body.question}".`,
      visualization: { id: `vis_${Date.now()}`, duration: 7000, fps: 30, layers: [] },
      timestamp: new Date().toISOString()
    };
    answers.push(fallback);
    broadcast('answer_created', fallback);
    res.json({ success: true, questionId: `q_${uuidv4()}`, answerId: fallback.id });
  }
});

app.get('/api/questions', (req, res) => res.json({ success: true, data: questions, count: questions.length }));

app.get('/api/answers/:id', (req, res) => {
  const ans = answers.find(a => a.id === req.params.id);
  if (!ans) return res.status(404).json({ error: 'Answer not found' });
  res.json({ success: true, data: ans });
});

app.get('/api/stream', (req, res) => {
  openSSE(req, res);
  const id = uuidv4();
  clients.push({ id, res });
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ clientId: id, ts: Date.now() })}\n\n`);
  const hb = setInterval(() => {
    if (!res.writableEnded) { res.write(`event: ping\n`); res.write('data: "keep-alive"\n\n'); }
  }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    const i = clients.findIndex(c => c.id === id);
    if (i !== -1) clients.splice(i, 1);
  });
});

// health check for cloud
app.get('/health', (_req, res) => res.json({ ok: true, model: LLM_MODEL }));

app.listen(PORT, () => console.log(`Backend on :${PORT} (Groq model: ${LLM_MODEL})`));
