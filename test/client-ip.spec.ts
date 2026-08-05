import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/index';

/**
 * The /64 truncation is the only control bounding an unauthenticated caller, so
 * it needs tests that fail on a wrong value rather than on a thrown error. The
 * property that matters: two hosts in one prefix must produce the SAME key, and
 * hosts in different prefixes must not.
 */

function ip(address?: string): string {
  const headers: Record<string, string> = {};
  if (address !== undefined) {
    headers['CF-Connecting-IP'] = address;
  }
  return clientIp(new Request('https://relay.test/v1/notify', { headers }));
}

describe('clientIp', () => {
  it('truncates an IPv6 address to its /64', () => {
    expect(ip('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  });

  it('puts two hosts in one /64 in the same bucket', () => {
    expect(ip('2001:db8:1:2:aaaa:bbbb:cc:dd')).toBe(ip('2001:db8:1:2:3:4:5:6'));
  });

  it('keeps different /64s in different buckets', () => {
    expect(ip('2001:db8:1:3:3:4:5:6')).not.toBe(ip('2001:db8:1:2:3:4:5:6'));
  });

  it('expands an elided run before slicing, so a short form matches its long form', () => {
    expect(ip('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ip('2001:db8::1')).toBe(ip('2001:db8:0:0:0:0:0:2'));
  });

  it('handles an address that is all zeroes', () => {
    expect(ip('::')).toBe('0:0:0:0::/64');
    expect(ip('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves IPv4 untouched, since truncating it would pool every IPv4 client', () => {
    expect(ip('203.0.113.7')).toBe('203.0.113.7');
    expect(ip('203.0.113.8')).not.toBe(ip('203.0.113.7'));
  });

  it('leaves an IPv4-mapped address untouched, as it names a single host', () => {
    expect(ip('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
  });

  it('falls back to a single shared bucket when the header is absent', () => {
    // Cloudflare always sets CF-Connecting-IP in production. Sharing one bucket
    // is the safe direction if it is ever missing.
    expect(ip()).toBe('unknown');
  });
});
