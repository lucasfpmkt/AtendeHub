import { Router } from 'express';
import { checkPassword, issueToken } from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const password = String(req.body?.password ?? '');
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'senha incorreta' });
  }
  res.json({ token: issueToken() });
});
