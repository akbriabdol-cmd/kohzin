
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const port = Number(process.env.PORT || 10000);

const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();
const FAL_KEY = process.env.FAL_KEY?.trim();

app.use(helmet());
app.use(express.json({ limit: '2mb' }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.get('/', (_req, res) => {
  res.json({ name: 'KOHZIN API', ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    chatConfigured: Boolean(GROQ_API_KEY),
    transcriptionConfigured: Boolean(GROQ_API_KEY),
    videoConfigured: Boolean(FAL_KEY),
    videoModels: ['standard', 'turbo'],
    videoModel: 'fal-ai/kling-video/v3/standard/text-to-video'
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(503).json({
        error: 'GROQ_API_KEY is not configured in Render.'
      });
    }

    const { message, messages } = req.body || {};
    const chatMessages = Array.isArray(messages)
      ? messages
      : typeof message === 'string'
        ? [{ role: 'user', content: message }]
        : [];

    if (!chatMessages.length) {
      return res.status(400).json({ error: 'A message is required.' });
    }

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: chatMessages,
          temperature: 0.7
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Groq chat request failed:', response.status);
      return res.status(response.status).json({
        error: data?.error?.message || 'Chat request failed.'
      });
    }

    return res.json({
      ok: true,
      reply: data.choices?.[0]?.message?.content || '',
      choices: data.choices
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    return res.status(500).json({ error: 'Chat service failed.' });
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(503).json({
        error: 'GROQ_API_KEY is not configured in Render.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Upload an audio file using the field name "file".'
      });
    }

    const form = new FormData();
    const audioBlob = new Blob([req.file.buffer], {
      type: req.file.mimetype || 'audio/mpeg'
    });

    form.append('file', audioBlob, req.file.originalname || 'audio.mp3');
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: form
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Transcription request failed:', response.status);
      return res.status(response.status).json({
        error: data?.error?.message || 'Transcription failed.'
      });
    }

    return res.json({
      ok: true,
      text: data.text || ''
    });
  } catch (error) {
    console.error('Transcription error:', error.message);
    return res.status(500).json({
      error: 'Transcription service failed.'
    });
  }
});

app.post('/api/generate-video', async (req, res) => {
  try {
    if (!FAL_KEY) {
      return res.status(503).json({
        error: 'FAL_KEY is not configured in Render.'
      });
    }

    const { prompt, model = 'standard' } = req.body || {};

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A video prompt is required.' });
    }

    const endpoint = model === 'turbo'
      ? 'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video'
      : 'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: prompt.trim() })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Video request failed:', response.status);
      return res.status(response.status).json({
        error: data?.detail || data?.message || 'Video request failed.'
      });
    }

    return res.json({
      ok: true,
      request_id: data.request_id,
      status_url: data.status_url,
      response_url: data.response_url,
      data
    });
  } catch (error) {
    console.error('Video error:', error.message);
    return res.status(500).json({ error: 'Video service failed.' });
  }
});

app.listen(port, () => {
  console.log(`KOHZIN secure API listening on ${port}`);

  console.log('KOHZIN environment check:', {
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY?.trim()),
    FAL_KEY: Boolean(process.env.FAL_KEY?.trim())
  });
});
