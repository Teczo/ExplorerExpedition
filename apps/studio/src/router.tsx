/**
 * The smallest router the Studio needs (EXPD-024).
 *
 * A routing library is a dependency, and no ticket has added one. The Studio
 * needs three things from a router — read the path, change it, and draw a
 * link — and the History API does all three. When a later screen needs
 * nested routes or path parameters, that is the moment to add a library.
 *
 * The deployed app already sends every unknown path to `index.html`
 * (`scripts/package-web.sh`), so a reload on a deep link works.
 */

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const CHANGE = 'studio:navigate';

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(CHANGE, listener);
  };
}

/** The current path, e.g. `/`. Redraws when it changes. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Goes to `path` without reloading the page. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) {
    return;
  }
  if (options.replace === true) {
    window.history.replaceState(null, '', path);
  } else {
    window.history.pushState(null, '', path);
  }
  window.dispatchEvent(new Event(CHANGE));
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** An `<a>` that navigates inside the Studio, and still opens a new tab on a modified click. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handleClick} {...rest} />;
}
