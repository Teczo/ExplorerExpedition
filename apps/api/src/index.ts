import { createApp } from './app.ts';

const DEFAULT_PORT = 3000;

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);

createApp().listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
