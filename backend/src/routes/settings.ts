import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const router = Router();
const envPath = path.join(__dirname, '../../.env');

router.get('/', (_req: Request, res: Response) => {
  if (!fs.existsSync(envPath)) return res.json({});
  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  res.json(envConfig);
});

export default router; 