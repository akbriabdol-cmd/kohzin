
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.GROQ_API_KEY;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));

const frontendOrigin = (process.env.FRONTEND_ORIGIN || '')
  .trim()
  .replace(/\/$/, '');

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (frontendOrigin && origin === frontendOrigin) {
    res.setHeader('Access-Control-Allow-Origin', frontendOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(
      frontendOrigin && origin === frontendOrigin ? 204 : 403
    );
  }

  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public', { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 24 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('لطفاً یک فایل صوتی معتبر انتخاب کن.'));
    }
  }
});

const transcribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'تعداد درخواست‌ها زیاد است؛ چند دقیقه دیگر دوباره تلاش کن.'
  }
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'تعداد پیام‌ها زیاد است؛ چند دقیقه دیگر دوباره تلاش کن.'
  }
});

const videoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 4,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'درخواست‌های ساخت ویدیو زیاد شده؛ یک ساعت بعد دوباره تلاش کن.'
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    chatConfigured: Boolean(apiKey),
    transcriptionConfigured: Boolean(apiKey),
    videoConfigured: Boolean(apiKey && process.env.FAL_KEY),
    videoModels: ['standard', 'turbo'],
    videoModel: 'fal-ai/kling-video/v3/standard/text-to-video'
  });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  if (!apiKey) {
    return res.status(503).json({
      error: 'سرویس هوش مصنوعی هنوز پیکربندی نشده است.'
    });
  }

  const allowedRoles = new Set(['user', 'assistant']);
  const incoming = Array.isArray(req.body?.messages)
    ? req.body.messages.slice(-12)
    : [];

  const messages = incoming
    .filter(m =>
      m &&
      allowedRoles.has(m.role) &&
      typeof m.content === 'string'
    )
    .map(m => ({
      role: m.role,
      content: m.content.slice(0, 3000)
    }));

  if (
    !messages.length ||
    messages[messages.length - 1].role !== 'user'
  ) {
    return res.status(400).json({
      error: 'پیام معتبر ارسال نشده است.'
    });
  }

  const languageNames = {
    fa: 'Persian/Dari',
    en: 'English',
    ar: 'Arabic',
    tr: 'Turkish',
    ur: 'Urdu',
    hi: 'Hindi',
    az: 'Azerbaijani'
  };

  const language =
    languageNames[req.body?.language] || 'Persian/Dari';

  try {
    const upstream = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.6,
          max_tokens: 700,
          messages: [
            {
              role: 'system',
              content:
                `You are KOHZIN, a helpful video-editing and filming assistant. Reply in ${language}. Explain steps simply for beginners. Never ask the user for an API key.`
            },
            ...messages
          ]
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      console.error('Groq chat failed:', upstream.status);
      return res.status(502).json({
        error: 'سرویس هوش مصنوعی فعلاً پاسخ نداد؛ بعداً دوباره تلاش کن.'
      });
    }

    const reply = data.choices?.[0]?.message?.content;

    if (typeof reply !== 'string' || !reply.trim()) {
      return res.status(502).json({
        error: 'پاسخی از سرویس دریافت نشد.'
      });
    }

    return res.json({ reply: reply.trim() });
  } catch (err) {
    console.error('Chat request failed:', err?.name || 'Error');
    return res.status(502).json({
      error: 'اتصال به دستیار هوشمند ناموفق بود.'
    });
  }
});

app.post('/api/generate-video', videoLimiter, async (req, res) => {
  if (!apiKey || !process.env.FAL_KEY) {
    return res.status(503).json({
      error: 'کلیدهای سرویس هوش مصنوعی یا تولید ویدیو تنظیم نشده‌اند.'
    });
  }

  const prompt = typeof req.body?.prompt === 'string'
    ? req.body.prompt.trim().slice(0, 1800)
    : '';

  if (!prompt) {
    return res.status(400).json({ error: 'توضیح ویدیو خالی است.' });
  }

  const ratios = new Set(['9:16', '16:9', '1:1']);
  const ratio = ratios.has(req.body?.aspect_ratio)
    ? req.body.aspect_ratio
    : '9:16';

  const durations = new Set([5, 10, 15]);
  const duration = durations.has(Number(req.body?.duration))
    ? Number(req.body.duration)
    : 5;

  const generateAudio = req.body?.generate_audio !== false;
  const model = req.body?.model === 'turbo' ? 'turbo' : 'standard';

  const endpoint = model === 'turbo'
    ? 'fal-ai/kling-video/v3/turbo/standard/text-to-video'
    : 'fal-ai/kling-video/v3/standard/text-to-video';

  try {
    const promptResponse = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 450,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content: 'Convert the user request into a precise English text-to-video prompt. Preserve the exact subject, action, setting, clothing and objects. Do not invent extra people or objects. Describe realistic motion and camera framing. Do not include text, subtitles, logos or watermarks. Return only the final prompt.'
            },
            {
              role: 'user',
              content: prompt + (
                generateAudio
                  ? '\nInclude suitable natural ambient sound where appropriate.'
                  : '\nNo audio is needed.'
              )
            }
          ]
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    const promptData = await promptResponse.json().catch(() => ({}));

    if (!promptResponse.ok) {
      return res.status(502).json({
        error: 'آماده‌سازی دستور ویدیو ناموفق بود.'
      });
    }

    const finalPrompt = String(
      promptData.choices?.[0]?.message?.content || ''
    ).trim().slice(0, 2400);

    if (!finalPrompt) {
      return res.status(502).json({
        error: 'دستور تولید ویدیو آماده نشد.'
      });
    }

    const submittedResponse = await fetch(
      `https://queue.fal.run/${endpoint}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: finalPrompt,
          duration: String(duration),
          aspect_ratio: ratio,
          generate_audio: generateAudio,
          negative_prompt: 'text, subtitles, logos, watermarks, blurry, distorted, low quality'
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    const job = await submittedResponse.json().catch(() => ({}));

    if (
      !submittedResponse.ok ||
      !job.request_id ||
      !job.status_url ||
      !job.response_url
    ) {
      return res.status(502).json({
        error: 'موتور تولید ویدیو درخواست را نپذیرفت.'
      });
    }

    const deadline = Date.now() + 300000;
    let status = 'IN_QUEUE';

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2500));

      const statusResponse = await fetch(job.status_url, {
        headers: {
          Authorization: `Key ${process.env.FAL_KEY}`
        },
        signal: AbortSignal.timeout(20000)
      });

      const statusData = await statusResponse.json().catch(() => ({}));

      if (!statusResponse.ok) {
        throw new Error('بررسی وضعیت تولید ویدیو ناموفق بود.');
      }

      status = statusData.status || status;

      if (status === 'COMPLETED') break;

      if (status === 'FAILED' || status === 'CANCELLED') {
        return res.status(502).json({
          error: 'ساخت ویدیو ناموفق بود؛ دستور را تغییر بده.'
        });
      }
    }

    if (status !== 'COMPLETED') {
      return res.status(504).json({
        error: 'ساخت ویدیو بیش از زمان انتظار طول کشید.'
      });
    }

    const resultResponse = await fetch(job.response_url, {
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`
      },
      signal: AbortSignal.timeout(30000)
    });

    const result = await resultResponse.json().catch(() => ({}));
    const videoUrl = result.video?.url || result.output?.video?.url;

    if (
      !resultResponse.ok ||
      typeof videoUrl !== 'string' ||
      !videoUrl.startsWith('https://')
    ) {
      return res.status(502).json({
        error: 'لینک امن ویدیو دریافت نشد.'
      });
    }

    return res.json({
      video_url: videoUrl,
      final_prompt: finalPrompt,
      duration,
      aspect_ratio: ratio,
      audio_requested: generateAudio,
      model
    });
  } catch (err) {
    console.error('Video generation failed:', err?.name || 'Error');
    return res.status(502).json({
      error: 'اتصال به موتور تولید ویدیو ناموفق بود.'
    });
  }
});

app.post(
  '/api/transcribe',
  transcribeLimiter,
  upload.single('file'),
  async (req, res) => {
    if (!apiKey) {
      return res.status(503).json({
        error: 'سرویس تبدیل صدا پیکربندی نشده است.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'فایل صوتی ارسال نشده است.'
      });
    }

    const languages = new Set(['fa', 'en', 'tr', 'ar', 'ur', 'hi']);
    const language = languages.has(req.body?.language)
      ? req.body.language
      : 'fa';

    try {
      const form = new FormData();

      form.append(
        'file',
        new Blob([req.file.buffer], {
          type: req.file.mimetype || 'audio/mpeg'
        }),
        req.file.originalname || 'audio.mp3'
      );

      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      form.append('language', language);

      const upstream = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`
          },
          body: form,
          signal: AbortSignal.timeout(120000)
        }
      );

      const data = await upstream.json().catch(() => ({}));

      if (!upstream.ok) {
        console.error('Groq transcription failed:', upstream.status);
        return res.status(502).json({
          error: 'سرویس تبدیل صدا موقتاً پاسخ نداد.'
        });
      }

      if (typeof data.text !== 'string' || !data.text.trim()) {
        return res.status(502).json({
          error: 'متنی از سرویس دریافت نشد.'
        });
      }

      return res.json({ text: data.text });
    } catch (err) {
      console.error('Transcription failed:', err?.name || 'Error');
      return res.status(502).json({
        error: 'اتصال به سرویس تبدیل صدا ناموفق بود.'
      });
    }
  }
);

app.use((err, _req, res, _next) => {
  if (
    err instanceof multer.MulterError &&
    err.code === 'LIMIT_FILE_SIZE'
  ) {
    return res.status(413).json({
      error: 'حجم فایل باید کمتر از 24 مگابایت باشد.'
    });
  }

  if (err) {
    return res.status(400).json({
      error: err.message || 'درخواست نامعتبر است.'
    });
  }

  return res.status(500).json({
    error: 'خطای داخلی سرور.'
  });
});

app.listen(port, () => {
  console.log(`KOHZIN secure API listening on ${port}`);
});
