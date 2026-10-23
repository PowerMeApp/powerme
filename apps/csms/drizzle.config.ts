import { defineConfig } from 'drizzle-kit';

// ADR-0008: Drizzle ORM cho truy vấn, migration viết bằng SQL thuần trong ./drizzle.
// drizzle-kit ở đây chỉ dùng cho `drizzle-kit check` / `studio`. KHÔNG dùng `generate`
// để sinh migration: partition (ADR-0007) và vài ràng buộc chỉ viết được bằng tay.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://powerme:powerme@localhost:5432/powerme',
  },
  strict: true,
  verbose: true,
});
