// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Loose request/response shapes for the Vercel Node runtime, declared here
// rather than imported.
//
// WHY declare them: foilkit has zero runtime dependencies, and that is a
// contract rather than an accident (AGENTS.md — everything in packages/ and
// tools/ runs on `node --test` with no build step and no dependencies). Adding
// `@vercel/node` for two interfaces would buy nothing the structural types
// below do not already buy: the runtime hands the handler a Node
// `IncomingMessage`/`ServerResponse` pair with a few extras bolted on, and
// TypeScript's structural typing accepts that against these shapes without the
// package ever being installed.
//
// Deliberately narrow. Only the members the functions in `functions/` actually touch
// appear here, so a member that shows up in a handler is a member somebody had
// to think about adding.

/** What a Vercel Node function receives as its first argument. */
export interface FnRequest {
  method?: string | undefined;
  /** Path + query, e.g. `/api/image?p=en/base/base1/4/high.webp`. */
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /**
   * Vercel pre-parses the query string onto the request. It is optional here so
   * the same handler can be driven by a plain Node server (or a test harness)
   * that only supplies `url`; `queryValue` falls back to parsing `url`.
   */
  query?: Record<string, string | string[] | undefined> | undefined;
  /**
   * Vercel parses a JSON request body onto `req.body` when the content-type
   * says so. Optional, because a plain Node server (or a test harness) hands
   * over a stream instead — `readJsonBody` handles both.
   */
  body?: unknown;
  /** Present when the body has to be read off the wire. */
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
}

/** How large a request body the write endpoints will read. A canonical mask
 *  PNG is single-digit KB; a data URL of one is under 50 KB. 8 MB is enormous
 *  by that standard and still small enough not to be a memory problem. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class BodyTooLarge extends Error {}

/**
 * The request body as JSON, from wherever it actually is.
 *
 * Returns `null` rather than throwing on malformed JSON: a handler answers 400
 * with its own message, which is more useful than a parse error the caller
 * cannot act on.
 */
export async function readJsonBody(req: FnRequest): Promise<unknown> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return null;
      }
    }
    return req.body;
  }
  const iterate = req[Symbol.asyncIterator];
  if (typeof iterate !== 'function') return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of { [Symbol.asyncIterator]: iterate.bind(req) }) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * A JSON answer for an AUTHENTICATED endpoint.
 *
 * Identical to `sendJson` except that it does NOT send
 * `access-control-allow-origin: *`. That header is right for the image proxy,
 * whose whole job is to be readable from anywhere; on an endpoint that answers
 * differently depending on a cookie it would be an invitation to read someone
 * else's answer, and `no-store` alone is not a substitute.
 */
export function sendPrivateJson(res: FnResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(Buffer.byteLength(encoded)));
  res.setHeader('cache-control', 'no-store');
  res.setHeader('vary', 'Cookie');
  res.end(encoded);
}

export function sendPrivateError(res: FnResponse, status: number, code: string, message: string): void {
  sendPrivateJson(res, status, { error: { code, message: sanitizeMessage(message) } });
}

/** A 302 that also (optionally) sets cookies. */
export function redirect(res: FnResponse, location: string, cookies: string[] = []): void {
  res.statusCode = 302;
  res.setHeader('location', location);
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  res.setHeader('cache-control', 'no-store');
  res.end();
}

/** What a Vercel Node function receives as its second argument. */
export interface FnResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  end(chunk?: string | Uint8Array): unknown;
}

/**
 * A single request header value, lower-cased name, `null` when absent.
 * Node lower-cases incoming header names already; we do it again because a test
 * harness constructing a request object by hand may not have.
 */
export function headerValue(req: FnRequest, name: string): string | null {
  const wanted = name.toLowerCase();
  const direct = req.headers[wanted];
  const raw =
    direct !== undefined
      ? direct
      : Object.entries(req.headers).find(([k]) => k.toLowerCase() === wanted)?.[1];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

/**
 * A single query parameter. Repeated parameters collapse to the FIRST value —
 * never the last, and never a joined string. A caller that sends `?p=a&p=b` is
 * either confused or probing; taking the first and validating it hard is the
 * behaviour with the smallest surface.
 */
export function queryValue(req: FnRequest, name: string): string | undefined {
  const fromRuntime = req.query?.[name];
  if (typeof fromRuntime === 'string') return fromRuntime;
  if (Array.isArray(fromRuntime)) return fromRuntime[0];

  if (typeof req.url !== 'string') return undefined;
  // The base is a throwaway: `req.url` is always origin-relative here, and we
  // only ever read `searchParams` off the result.
  let parsed: URL;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    return undefined;
  }
  const value = parsed.searchParams.get(name);
  return value === null ? undefined : value;
}

/**
 * Make a string safe to put in a JSON error body.
 *
 * Nothing here is defending against XSS — the body is `application/json` and is
 * never interpolated into a document. It defends against two dumber things: a
 * caller smuggling control characters (including CR/LF, which is how a naive
 * logger gets a forged line written into it) and a caller sending a megabyte of
 * junk to be echoed back. Handlers should still prefer messages that are
 * DERIVED from the input rather than MADE OF it — see `resolveUpstream`, whose
 * rejection reasons never contain a byte the caller supplied.
 */
export function sanitizeMessage(text: string, maxLength = 200): string {
  const stripped = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1)}\u2026` : stripped;
}

/** The one error body shape every function in `functions/` answers with. */
export interface ErrorBody {
  error: { code: string; message: string };
}

export function sendJson(res: FnResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(Buffer.byteLength(encoded)));
  // Errors are as public as successes here; a browser that can read the image
  // should be able to read the reason it did not get one.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  res.end(encoded);
}

export function sendError(
  res: FnResponse,
  status: number,
  code: string,
  message: string,
): void {
  const body: ErrorBody = { error: { code, message: sanitizeMessage(message) } };
  sendJson(res, status, body);
}
