/**
 * Where the Studio finds the API (EXPD-024).
 *
 * `VITE_API_URL` is read at build time. Left unset, the Studio calls `/api`
 * on its own origin, which `npm run dev:studio` forwards to the API on
 * http://localhost:3000 (see `vite.config.ts`).
 */
export const API_BASE_URL: string = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');
