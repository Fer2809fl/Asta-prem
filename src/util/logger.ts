/* eslint-disable no-console */
function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const logger = {
  info(msg: string, ...rest: unknown[]): void {
    console.log(`[${ts()}] ℹ️  ${msg}`, ...rest);
  },
  ok(msg: string, ...rest: unknown[]): void {
    console.log(`[${ts()}] ✅ ${msg}`, ...rest);
  },
  warn(msg: string, ...rest: unknown[]): void {
    console.warn(`[${ts()}] ⚠️  ${msg}`, ...rest);
  },
  error(msg: string, ...rest: unknown[]): void {
    console.error(`[${ts()}] ❌ ${msg}`, ...rest);
  },
};
