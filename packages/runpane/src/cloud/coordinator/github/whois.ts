import { execFile } from 'node:child_process';
import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { Clock } from '../types';

/** A tailnet node as `tailscale whois` reports it. */
export interface TailnetNode {
  stableId: string;
  /** MagicDNS name without the trailing dot, lowercased. */
  name: string;
  tags: string[];
}

export interface WhoisResolver {
  /** null when the address is not a tailnet node (or whois fails). */
  whois(address: string): Promise<TailnetNode | null>;
}

const whoisSchema = boundary.object({
  Node: boundary.object({
    StableID: boundary.nonEmptyString,
    Name: boundary.nonEmptyString,
    Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  }),
});

const CACHE_MS = 30_000;
const IPV4_TAILNET = /^100\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/u;
const IPV6_TAILNET = /^fd7a:115c:a1e0:[0-9a-f:]+$/iu;

/** Strips the IPv4-mapped prefix a dual-stack socket reports (`::ffff:100.x.y.z`). */
export function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/iu, '');
}

export function parseWhois(stdout: string): TailnetNode {
  const decoded = decodeBoundary(JSON.parse(stdout), whoisSchema);
  return {
    stableId: decoded.Node.StableID,
    name: decoded.Node.Name.replace(/\.$/u, '').toLowerCase(),
    tags: decoded.Node.Tags ?? [],
  };
}

/**
 * Asks the local tailscaled who a tailnet address belongs to (`tailscale whois --json <ip>`, read-only
 * LocalAPI access). Answers are cached for 30 s per address.
 */
export class TailscaleWhois implements WhoisResolver {
  private readonly cache = new Map<string, { at: number; node: TailnetNode | null }>();

  constructor(private readonly clock: Clock, private readonly tailscaleBin = 'tailscale') {}

  async whois(address: string): Promise<TailnetNode | null> {
    const ip = normalizeAddress(address);
    if (!IPV4_TAILNET.test(ip) && !IPV6_TAILNET.test(ip)) return null;
    const cached = this.cache.get(ip);
    if (cached && this.clock.now() - cached.at < CACHE_MS) return cached.node;
    const answer = await new Promise<{ node: TailnetNode | null; cache: boolean }>((resolve) => {
      execFile(this.tailscaleBin, ['whois', '--json', ip], { timeout: 5_000, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          // Not cached: an unknown address and a tailscaled hiccup both fail closed, but only the first persists.
          console.error(`[coordinator] tailscale whois ${ip} failed: ${(stderr || error.message).trim().slice(0, 300)}`);
          resolve({ node: null, cache: false });
          return;
        }
        try {
          resolve({ node: parseWhois(stdout), cache: true });
        } catch {
          resolve({ node: null, cache: false });
        }
      });
    });
    if (answer.cache) this.cache.set(ip, { at: this.clock.now(), node: answer.node });
    return answer.node;
  }
}
