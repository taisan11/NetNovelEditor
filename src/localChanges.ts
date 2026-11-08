const listeners = new Set<() => void>();

export function notifyLocalChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeLocalChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
