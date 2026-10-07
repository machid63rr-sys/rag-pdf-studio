import type { Response } from 'express';

/** このサーバのAPIが返す、エラーの形式: {"error": {"code": "…", "message": "…"}} */
export const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};
