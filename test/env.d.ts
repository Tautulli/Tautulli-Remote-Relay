import type { Env } from '../src/types';

// `env` from 'cloudflare:test' is typed as an empty ProvidedEnv until the worker's
// own bindings are declared onto it.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
