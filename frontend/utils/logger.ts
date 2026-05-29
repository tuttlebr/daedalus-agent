type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Resolve the minimum level that should be emitted.
 *
 * Honors an explicit `LOG_LEVEL` env var; otherwise defaults to hiding `debug`
 * in production (where it was previously always emitted, including per-user
 * token counts) while showing everything in development (F-013).
 */
function resolveThreshold(): number {
  const configured = (process.env.LOG_LEVEL || '').toLowerCase();
  if (configured in LEVEL_PRIORITY) {
    return LEVEL_PRIORITY[configured as LogLevel];
  }
  return process.env.NODE_ENV === 'production'
    ? LEVEL_PRIORITY.info
    : LEVEL_PRIORITY.debug;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= resolveThreshold();
  }

  private formatMessage(level: LogLevel, message: string): string {
    return `[${level.toUpperCase()}] [${this.context}] ${message}`;
  }

  info(message: string, ...args: any[]): void {
    if (this.enabled('info')) {
      console.log(this.formatMessage('info', message), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.enabled('warn')) {
      console.warn(this.formatMessage('warn', message), ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.enabled('error')) {
      console.error(this.formatMessage('error', message), ...args);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.enabled('debug')) {
      console.debug(this.formatMessage('debug', message), ...args);
    }
  }
}
