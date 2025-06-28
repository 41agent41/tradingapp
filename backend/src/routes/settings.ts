import { Router, Request, Response } from 'express';
import fs from 'fs';
import dotenv from 'dotenv';

const router = Router();
const envPath = '/app/.env';

router.get('/', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(envPath)) {
      console.log('Environment file not found at:', envPath);
      return res.json({});
    }
    
    const envContent = fs.readFileSync(envPath, 'utf8');
    const envConfig = dotenv.parse(envContent);
    res.json(envConfig);
  } catch (error) {
    console.error('Error reading settings:', error);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

export default router; 