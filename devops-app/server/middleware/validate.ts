import type { Request, Response, NextFunction } from "express";
import { type ZodSchema, ZodError } from "zod";

export function validateBody(schema: ZodSchema) {
  // Async parse so schemas with async `.superRefine()` (e.g. SSRF guard on
  // healthUrl) work correctly. Sync schemas pay no extra cost.
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const result = await schema.safeParseAsync(req.body);
    if (!result.success) {
      let code = "VALIDATION_ERROR";
      for (const issue of result.error.issues) {
        const params = (issue as { params?: { error_code?: string } }).params;
        if (params?.error_code === "health_url_blocked") {
          code = "health_url_blocked";
          break;
        }
      }
      res.status(400).json({
        error: {
          code,
          message: "Request body validation failed",
          details: formatZodErrors(result.error),
        },
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request params validation failed",
          details: formatZodErrors(result.error),
        },
      });
      return;
    }
    next();
  };
}

function formatZodErrors(error: ZodError): Record<string, string[]> {
  const formatted: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!formatted[key]) formatted[key] = [];
    formatted[key].push(issue.message);
  }
  return formatted;
}
