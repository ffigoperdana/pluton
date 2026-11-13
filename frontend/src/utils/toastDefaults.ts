/** Success, info and warning toasts close by themselves; at most this many show at once. */
export const TOAST_AUTO_CLOSE_MS = 3000;
export const TOAST_LIMIT = 4;

type ToastOptions = Record<string, unknown>;
type ToastErrorApi = {
   error: (content: never, options?: ToastOptions) => unknown;
   promise?: (promise: never, params: never, options?: ToastOptions) => unknown;
};
const INSTALLED = Symbol.for('pluton.toast.stickyErrors');
const STICKY = { autoClose: false, closeButton: true };

/** `toast.promise` error option (text, element, render function or update options) that stays open. */
export function stickyPromiseError(error: unknown) {
   if (error && typeof error === 'object' && 'render' in error) return { ...STICKY, ...(error as ToastOptions) };
   return { ...STICKY, render: error };
}

/**
 * Errors stay until closed so their text can be read or reported, including the
 * error state of `toast.promise`. A call that passes its own `autoClose` keeps
 * it. Installing twice is a no-op.
 */
export function keepErrorToastsOpen<T extends ToastErrorApi>(api: T): T {
   const target = api as T & { [INSTALLED]?: true };
   if (target[INSTALLED]) return api;
   const error = api.error.bind(api);
   target.error = ((content: unknown, options?: ToastOptions) => error(content as never, { ...STICKY, ...options })) as T['error'];
   if (api.promise) {
      const promise = api.promise.bind(api);
      target.promise = ((pending: unknown, params?: ToastOptions, options?: ToastOptions) =>
         promise(
            pending as never,
            (params && params.error !== undefined ? { ...params, error: stickyPromiseError(params.error) } : params) as never,
            options,
         )) as T['promise'];
   }
   target[INSTALLED] = true;
   return api;
}
