import { NextApiRequest, NextApiResponse } from 'next';
import { verifyCredentials, initializeUsers } from '@/utils/auth/users';
import { createSession } from '@/utils/auth/session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // SECURITY: Explicitly reject GET requests with credential parameters
  if (req.method === 'GET') {
    const hasCredentials = req.query.username || req.query.password;
    if (hasCredentials) {
      // Log security event without exposing credentials
      console.warn('[SECURITY] Attempted credential exposure via GET parameters', {
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
      });
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ error: 'Method not allowed. Credentials must be sent via POST request body.' });
    }
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // SECURITY: Additional check - reject if credentials are in query string even for POST
  if (req.query.username || req.query.password) {
    console.warn('[SECURITY] Attempted credential exposure via query parameters in POST request', {
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
    });
    return res.status(400).json({ error: 'Credentials must be sent in request body, not query parameters.' });
  }

  try {
    // Initialize default users if needed
    await initializeUsers();

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Verify credentials
    const user = await verifyCredentials(username, password);

    if (!user) {
      // SECURITY: Log failed login attempt with masked username
      console.warn('[AUTH] Failed login attempt', {
        username: username.length > 2 ? username[0] + '***' + username[username.length - 1] : '***',
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        timestamp: new Date().toISOString(),
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Create session
    const { passwordHash, ...userWithoutPassword } = user;
    await createSession(req, res, userWithoutPassword);

    return res.status(200).json({
      success: true,
      user: userWithoutPassword,
    });
  } catch (error) {
    // SECURITY: Log error without exposing sensitive data
    console.error('[AUTH] Login error:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      timestamp: new Date().toISOString(),
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
