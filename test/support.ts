/** An unsigned JWT with `claims` (the browser reads tokens unverified). */
export const unsignedJwt = (claims: object) =>
  `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
