import { Router } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file provided' });
    }

    const whisperUrl = process.env.WHISPER_API_URL;
    const whisperKey = process.env.WHISPER_API_KEY;
    const whisperModel = process.env.WHISPER_MODEL || 'whisper-1';

    if (!whisperUrl || !whisperKey) {
      return res.status(500).json({ message: 'Whisper API not configured' });
    }

    // Create form data
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), 'audio.webm');
    formData.append('model', whisperModel);

    const response = await fetch(`${whisperUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${whisperKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Whisper API error:', error);
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
