/**
 * The Studio's screens (EXPD-024).
 *
 * One line per screen. The shell draws the navigation from `NAVIGATION` and
 * `App` picks the page from `ROUTES`, so a later ticket (EXPD-025 onwards)
 * adds its screen here and nowhere else.
 */

import type { ComponentType } from 'react';

import { ExpeditionsPage } from './pages/ExpeditionsPage.tsx';
import { MediaLibraryPage } from './pages/MediaLibraryPage.tsx';
import { MissionTypesPage } from './pages/MissionTypesPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';

interface Route {
  readonly path: string;
  readonly label: string;
  readonly page: ComponentType;
}

export const ROUTES: readonly Route[] = [
  { path: '/', label: 'Overview', page: OverviewPage },
  { path: '/mission-types', label: 'Mission types', page: MissionTypesPage },
  { path: '/expeditions', label: 'Expedition graphs', page: ExpeditionsPage },
  { path: '/media', label: 'Media library', page: MediaLibraryPage },
];

/** What the side navigation lists, in order. */
export const NAVIGATION: readonly Route[] = ROUTES;
