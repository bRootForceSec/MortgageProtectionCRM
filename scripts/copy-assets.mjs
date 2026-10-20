// Copies the SQL migrations and data files next to the compiled server. Plain Node so the build works on Windows too.
import fs from 'node:fs';

for (const [from, to] of [
  ['src/server/db/migrations', 'dist/server/db/migrations'],
  ['src/server/data', 'dist/server/data'],
]) {
  fs.cpSync(from, to, { recursive: true });
}
