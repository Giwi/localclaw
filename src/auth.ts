import type { Request, Response, NextFunction } from 'express'
import { log } from './log.js'

const API_KEY = process.env.LOCALCLAW_API_KEY

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next()

  if (req.path === '/health') return next()

  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== API_KEY) {
    log.warn(`Auth rejected: ${req.method} ${req.originalUrl}`)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}
