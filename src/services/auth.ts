// ============================================================
// JWT 认证服务
// ============================================================
import { SignJWT, jwtVerify } from 'jose';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env, User } from '../types';

const encoder = new TextEncoder();

export async function signToken(user: User, env: Env): Promise<string> {
  const secret = encoder.encode(env.JWT_SECRET);
  return new SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .setIssuedAt()
    .sign(secret);
}

export async function verifyToken(token: string, env: Env): Promise<{ sub: string; username: string; role: string } | null> {
  try {
    const secret = encoder.encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return {
      sub: payload.sub as string,
      username: payload.username as string,
      role: payload.role as string,
    };
  } catch {
    return null;
  }
}

export async function getUserById(supabase: SupabaseClient, userId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data as User;
}

export async function getUserByUsername(supabase: SupabaseClient, username: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();
  if (error) return null;
  return data as User;
}
