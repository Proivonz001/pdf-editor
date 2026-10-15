// Stand-in for vite-plugin-pwa's virtual:pwa-register: records the options it is given.
export const captured: { options?: Record<string, (...args: unknown[]) => void>; updateCalls: number } = { updateCalls: 0 };

export function registerSW(options: Record<string, (...args: unknown[]) => void>) {
  captured.options = options;
  return async () => {
    captured.updateCalls++;
  };
}
