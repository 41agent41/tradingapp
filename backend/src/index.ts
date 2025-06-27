import express from 'express';
import type { Request, Response } from 'express';
import settingsRouter from './routes/settings';
import bodyParser from 'body-parser';

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = '0.0.0.0';

app.use(bodyParser.json());
app.use('/api/settings', settingsRouter);

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

app.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
});
