import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Dev: full query logging (each SQL statement) — invaluable for debugging
    // the N+1s and accidental full-table loads this codebase cares about.
    // Production: errors only — query logging every statement is noisy and
    // leaks data shapes into prod logs.
    log:
      process.env.NODE_ENV === 'production'
        ? ['error']
        : ['query', 'error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db