import { createApiClient } from './client';
import type { ApiClient } from './client';

/** Opt in to the public Vite configuration without an eager client or env read. */
export function createConfiguredApiClient(): ApiClient {
  return createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' });
}
