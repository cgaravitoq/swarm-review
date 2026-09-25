const refusals = new WeakMap<Response, string>();

export const markRelayRefusal = (response: Response, reason: string) =>
  refusals.set(response, reason);

export const relayRefusalReason = (response: Response) =>
  refusals.get(response) ?? null;
