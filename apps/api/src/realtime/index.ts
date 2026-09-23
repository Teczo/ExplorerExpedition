/**
 * The realtime channel (EXPD-023).
 *
 * Where to look:
 *
 *   `broker.ts`        Carrying a message between API instances, and the in-process broker.
 *   `resp.ts`          The Redis wire protocol, read and written by hand.
 *   `redis-broker.ts`  Redis pub/sub as a broker, with reconnection.
 *   `hub.ts`           Publishing a run's events, and delivering them to the right streams.
 *   `notices.ts`       What each change tells the run, and who hears it.
 *   `stream.ts`        One open stream, as Server-Sent Events.
 *   `routes.ts`        The stream endpoint, and announcements.
 *
 * What is deliberately not here. The student app's handling of these events
 * is EXPD-047, and Director Mode's is EXPD-055. Triggers a teacher sets up to
 * fire on their own are EXPD-057.
 */

export * from './broker.ts';
export * from './resp.ts';
export * from './redis-broker.ts';
export * from './hub.ts';
export * from './notices.ts';
export * from './stream.ts';
export * from './routes.ts';
