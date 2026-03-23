import { NextApiRequest, NextApiResponse } from 'next';
import { listUsers, createUser, updateUserPassword } from '@/utils/auth/users';
import { requireAuth, getSession } from '@/utils/auth/session';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSession(req, res);

  // Only allow admin users to manage users
  if (session?.username !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }

  if (req.method === 'GET') {
    // List all users
    try {
      const users = await listUsers();
      return res.status(200).json({ users });
    } catch (error) {
      console.error('Error listing users:', error);
      return res.status(500).json({ error: 'Failed to list users' });
    }
  } else if (req.method === 'POST') {
    // Create a new user
    try {
      const { username, password, name } = req.body;

      if (!username || !password || !name) {
        return res.status(400).json({ error: 'Username, password, and name are required' });
      }

      const user = await createUser(username, password, name);
      const { passwordHash, ...userWithoutPassword } = user;

      return res.status(201).json({ user: userWithoutPassword });
    } catch (error) {
      if (error instanceof Error && error.message === 'User already exists') {
        return res.status(409).json({ error: 'User already exists' });
      }
      console.error('Error creating user:', error);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  } else if (req.method === 'PATCH') {
    // Update user password
    try {
      const { username, newPassword } = req.body;

      if (!username || !newPassword) {
        return res.status(400).json({ error: 'Username and new password are required' });
      }

      const updated = await updateUserPassword(username, newPassword);

      if (!updated) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({ message: 'Password updated successfully' });
    } catch (error) {
      console.error('Error updating password:', error);
      return res.status(500).json({ error: 'Failed to update password' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'PATCH']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

// Protect this endpoint with authentication
export default requireAuth(handler);
