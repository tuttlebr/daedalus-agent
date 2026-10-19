import { registeredScriptSource } from '@/server/session/redisScript';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';

export interface RecordedCommand {
  /** Serial round-trip layer: commands sent while another is in flight share it. */
  layer: number;
  name: string;
  /** The script's `-- TAG` line for EVAL/EVALSHA, otherwise the first key. */
  tag: string;
  args: unknown[];
  replyBytes: number;
  /** A digest call Redis refused because its script cache was empty. */
  cacheMiss?: boolean;
}

const scriptTags = new Map<string, string>();

function scriptTag(script: string): string {
  return script.match(/-- ([A-Z_]+)/)?.[1] ?? script.trim().slice(0, 40);
}

/**
 * Record the Redis commands a client sends and group them into serial round
 * trips. Commands issued together (Promise.all) are sent before any reply
 * arrives, so they share a layer; each await on a reply starts a new one.
 */
export function recordRedisLayers(...clients: Redis[]) {
  const commands: RecordedCommand[] = [];
  let inflight = 0;
  let layer = 0;
  const restores = clients.map((client) => {
    const original = client.sendCommand.bind(client);
    (client as any).sendCommand = (command: any, stream?: any) => {
      const name = String(command.name).toUpperCase();
      const args = (command.args ?? []).map((arg: unknown) =>
        Buffer.isBuffer(arg) ? arg.toString() : arg,
      );
      let tag = String(args[0] ?? '');
      if (name === 'EVAL') {
        tag = scriptTag(tag);
      } else if (name === 'EVALSHA') {
        const source = registeredScriptSource(tag);
        tag = source ? scriptTag(source) : scriptTags.get(tag) ?? 'EVALSHA';
      }
      if (name === 'EVAL') {
        // Remember digests so later EVALSHA calls carry the same tag.
        scriptTags.set(
          createHash('sha1').update(String(args[0])).digest('hex'),
          tag,
        );
      }
      if (inflight === 0) layer += 1;
      inflight += 1;
      const entry: RecordedCommand = {
        layer,
        name,
        tag,
        args,
        replyBytes: 0,
      };
      commands.push(entry);
      const settle = () => {
        inflight -= 1;
      };
      command.promise.then(
        (reply: unknown) => {
          try {
            entry.replyBytes = Buffer.byteLength(
              typeof reply === 'string' ? reply : JSON.stringify(reply ?? null),
            );
          } catch {
            // Replies that cannot be serialized are not measured.
          }
          settle();
        },
        (error: unknown) => {
          entry.cacheMiss =
            name === 'EVALSHA' &&
            /^NOSCRIPT\b/.test(String((error as any)?.message));
          settle();
        },
      );
      return original(command, stream);
    };
    return () => {
      delete (client as any).sendCommand;
    };
  });
  // A cold script cache costs one refused digest call per script; steady
  // state (a warm cache) is what each turn pays.
  const steady = () => commands.filter((command) => !command.cacheMiss);
  return {
    commands,
    steady,
    layers: () => new Set(steady().map((command) => command.layer)).size,
    stop: () => restores.forEach((restore) => restore()),
  };
}
