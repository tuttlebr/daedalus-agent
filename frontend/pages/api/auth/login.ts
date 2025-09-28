import { NextApiRequest, NextApiResponse } from 'next';
import { verifyCredentials, initializeUsers } from '@/utils/auth/users';
import { createSession } from '@/utils/auth/session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
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
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
