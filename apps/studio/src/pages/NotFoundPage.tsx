import { Link } from '../router.tsx';

export function NotFoundPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-300">Nothing in Studio lives at this address.</p>
      <Link to="/" className="mt-6 inline-block text-sky-400 hover:underline">
        Go to the overview
      </Link>
    </section>
  );
}
