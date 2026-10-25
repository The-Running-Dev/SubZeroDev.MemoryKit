import type { Principal } from '../access/index.ts';
import type { TokenStore } from '../contracts/index.ts';
import { UnauthenticatedError } from '../model/index.ts';

// Turns a request's headers into a principal, or throws Unauthenticated or
// AuthenticationUnavailable before anything else runs.
export interface Authenticator {
  authenticate(headers: Headers): Promise<Principal>;
}

export function bearerToken(headers: Headers): string {
  const header = headers.get('authorization');
  if (header === null) {
    throw new UnauthenticatedError('A bearer token is required', { reason: 'missing' });
  }
  const match = /^Bearer +(\S+) *$/i.exec(header);
  if (!match) {
    throw new UnauthenticatedError('The Authorization header is not a bearer token', {
      reason: 'malformed',
    });
  }
  return match[1]!;
}

export class LocalTokenAuthenticator implements Authenticator {
  private readonly tokens: TokenStore;

  constructor(tokens: TokenStore) {
    this.tokens = tokens;
  }

  async authenticate(headers: Headers): Promise<Principal> {
    const principal = await this.tokens.verify(bearerToken(headers));
    if (principal === null) {
      throw new UnauthenticatedError('The token is not valid', { reason: 'invalid' });
    }
    return principal;
  }
}
