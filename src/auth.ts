import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "./config.js";

export function authenticate(apiKeys: Config["apiKeys"]): RequestHandler {
  const digest = (key: string) => createHash("sha256").update(key).digest("hex");
  const principals = new Map(apiKeys.map(({ key, principal }) => [digest(key), principal]));
  return (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.get("authorization") ?? "");
    const principal = match?.[1] ? principals.get(digest(match[1])) : undefined;
    if (!principal) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "A valid Bearer API key is required" } });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals.principal?.kind !== "admin") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Platform administrator access required" } });
    return;
  }
  next();
};

export const requireTenant: RequestHandler = (_req, res, next) => {
  const principal = res.locals.principal;
  if (!principal || principal.kind === "admin") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Tenant or service identity required" } });
    return;
  }
  next();
};
