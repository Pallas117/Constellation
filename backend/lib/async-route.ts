import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 ignores the promise an async handler returns. A rejection there (a bedrock read that
 * fails, a malformed upstream reply, a TypeError on an odd body) is an unhandled rejection, and
 * Node's default for those ends the process: one request could take the backend down. Wrapping
 * the handler sends the rejection to `next`, so the app's error handler answers a fixed 500 (or,
 * if the answer had already started, Express closes the connection) and the process keeps serving.
 */
export function asyncRoute<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req as Req, res, next))
      .catch(next);
  };
}
