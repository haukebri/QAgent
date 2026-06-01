import { streamSimple } from '@earendil-works/pi-ai';

export function streamWithRequestAuth(resolveRequestAuth) {
  return async (model, context, options) => {
    const auth = (await resolveRequestAuth(model)) ?? {};
    const headers = auth.headers || options?.headers
      ? { ...(options?.headers ?? {}), ...(auth.headers ?? {}) }
      : undefined;

    return streamSimple(model, context, {
      ...options,
      ...auth,
      ...(headers ? { headers } : {}),
    });
  };
}
