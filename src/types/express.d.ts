import type { RequestAuthContext } from "./domain";

declare global {
  namespace Express {
    interface Request {
      roomAuth?: RequestAuthContext;
    }
  }
}

export {};
