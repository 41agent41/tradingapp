import express from 'express';
import type { Request, Response } from 'express';
import type {} from 'node';
const app = express();
const PORT = process.env.PORT || 4000;

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
