import express from 'express';
import type { Request, Response } from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = '0.0.0.0';

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

app.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
});
