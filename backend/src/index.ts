import express from 'express';
import type { Request, Response } from 'express';
import settingsRouter from './routes/settings';
import bodyParser from 'body-parser';
import cors from 'cors';

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = '0.0.0.0';

// Configure CORS to allow requests from frontend
app.use(cors({
  origin: ['http://10.7.3.20:3000', 'http://localhost:3000'],
  credentials: true
}));

app.use(bodyParser.json());

// Root route with API information
app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'TradingApp Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      settings: '/api/settings'
    },
    documentation: 'This is the backend API for TradingApp. Use the frontend at http://10.7.3.20:3000 for the web interface.'
  });
});

app.use('/api/settings', settingsRouter);

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

app.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`CORS enabled for: http://10.7.3.20:3000, http://localhost:3000`);
  console.log(`API Documentation available at: http://${HOST}:${PORT}/`);
});
