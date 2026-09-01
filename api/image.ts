// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// `GET /api/image` — the card-scan read path for the hosted editor.
//
// Card scans are pulled BY REFERENCE at view time. Nothing is committed to this
// repository and nothing is redistributed (AGENTS.md F2): this function holds
// bytes in memory for the length of one request, hands them to the browser, and
// forgets them. The citation ships; the pixels do not.
//
// The reasons this proxy exists, the SSRF-by-construction rule, and the
// standing "no transcode, ever" decision all live in `_lib/upstream.ts`'s
// header, next to the code that implements them. Read that file first.
//
// This file is only the HTTP shape:
//   GET|HEAD /api/image?p=en/base/base1/4/high.webp
//   GET|HEAD /api/image?src=https://assets.tcgdex.net/en/base/base1/4/high.webp
//
// Status codes are chosen to be diagnosable, which is why there are four of
// them rather than two:
//   400 — the request never named a resolvable upstream asset
//   404 — upstream says this card has no scan
//   502 — upstream answered, and what it answered with was wrong (the soft-404
//         trap, or a non-WebP body). NOT a 404: a contributor staring at a
//         blank editor needs to tell "no scan exists" from "the CDN is serving
//         an error page with a 200 on it".
//   405 — a method other than GET or HEAD

import {
  headerValue,
  queryValue,
  sendError,
  type FnRequest,
  type FnResponse,
} from './_lib/http.ts';
import { fetchAsset, resolveUpstream, IMMUTABLE_CACHE_CONTROL } from './_lib/upstream.ts';

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    sendError(res, 405, 'method_not_allowed', 'this endpoint serves GET and HEAD only');
    return;
  }

  const resolved = resolveUpstream({
    p: queryValue(req, 'p'),
    src: queryValue(req, 'src'),
  });

  if (!resolved.ok) {
    // `resolved.reason` is written by `resolveUpstream` and never contains a
    // byte the caller supplied, so nothing of the raw input is echoed back
    // here. `sendError` sanitizes anyway, because the next reason someone adds
    // may not be as careful as the current ones.
    sendError(res, 400, 'bad_request', resolved.reason);
    return;
  }

  const ifNoneMatch = headerValue(req, 'if-none-match');
  const result = await fetchAsset(resolved.url, { etag: ifNoneMatch });

  // Every answer below names the upstream it resolved, success or failure.
  // Subtask 4's frame registry keys a framing on source URL + raster
  // dimensions; putting the URL on the response makes that key OBSERVABLE
  // rather than something the client has to reconstruct and hope matches.
  //
  // On logging: there is no secret in these URLs — no token, no user, no
  // internal hostname, and the origin is a public CDN — so exposing one in a
  // header is safe by inspection rather than by luck. That is also why nothing
  // in this file logs the request URL at error level: not because it would leak
  // today, but because a log line that grows a query parameter later is how
  // that stops being true quietly.
  res.setHeader('x-foilkit-upstream', resolved.url);
  res.setHeader('access-control-allow-origin', '*');

  switch (result.status) {
    case 'not-modified': {
      res.statusCode = 304;
      res.setHeader('cache-control', IMMUTABLE_CACHE_CONTROL);
      if (ifNoneMatch !== null) res.setHeader('etag', ifNoneMatch);
      res.end();
      return;
    }

    case 'ok': {
      res.statusCode = 200;
      // Bytes in, bytes out — the content-type is upstream's, unchanged.
      res.setHeader('content-type', result.contentType);
      res.setHeader('content-length', String(result.body.byteLength));
      res.setHeader('cache-control', IMMUTABLE_CACHE_CONTROL);
      if (result.etag !== null) res.setHeader('etag', result.etag);
      // A HEAD gets every header and no body, which is what makes it useful for
      // asking "does this scan exist" without spending a scan's worth of bytes.
      res.end(method === 'HEAD' ? undefined : result.body);
      return;
    }

    case 'rejected': {
      sendError(res, 502, 'upstream_rejected', result.reason);
      return;
    }

    case 'error': {
      if (result.httpStatus === 404) {
        sendError(res, 404, 'not_found', 'upstream has no scan at this path');
        return;
      }
      if (result.httpStatus === 410) {
        sendError(res, 404, 'not_found', 'upstream reports this scan is gone');
        return;
      }
      sendError(res, 502, 'upstream_error', result.reason);
      return;
    }
  }
}
