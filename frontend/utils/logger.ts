type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(level: LogLevel, message: string): string {
    return `[${level.toUpperCase()}] [${this.context}] ${message}`;
  }

  info(message: string, ...args: any[]): void {
    console.log(this.formatMessage('info', message), ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(this.formatMessage('warn', message), ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(this.formatMessage('error', message), ...args);
  }

  debug(message: string, ...args: any[]): void {
    console.debug(this.formatMessage('debug', message), ...args);
  }
}
