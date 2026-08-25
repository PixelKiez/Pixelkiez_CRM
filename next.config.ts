import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 enthält eine native Binary und darf nicht gebündelt werden.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
