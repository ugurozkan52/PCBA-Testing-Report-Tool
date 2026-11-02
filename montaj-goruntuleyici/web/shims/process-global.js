// injected: the few `process` fields the shared code uses
export const process = { pid: 1, env: { NODE_ENV: 'production' }, platform: 'browser', cwd: () => '/', version: '', versions: {}, nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)) };
