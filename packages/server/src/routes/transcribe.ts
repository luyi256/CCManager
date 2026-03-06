import { Router } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file provided' });
    }

    // Whisper API configuration (supports Groq, OpenAI, etc.)
    const apiKey = process.env.WHISPER_API_KEY || process.env.GROQ_API_KEY;
    const apiUrl = process.env.WHISPER_API_URL || 'https://api.groq.com/openai/v1';
    const model = process.env.WHISPER_MODEL || process.env.GROQ_MODEL || 'whisper-large-v3-turbo';

    if (!apiKey) {
      return res.status(500).json({ message: 'Whisper API not configured (set WHISPER_API_KEY)' });
    }

    // Create form data for Groq API
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), 'audio.webm');
    formData.append('model', model);
    formData.append('response_format', 'json');

    const response = await fetch(`${apiUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Groq API error:', error);
      return res.status(500).json({ message: 'Transcription failed' });
    }

    const result = await response.json() as { text: string };
    res.json({ text: result.text });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ message: 'Transcription failed' });
  }
});

export default router;
