import fg from 'fast-glob';

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.next/**', '**/coverage/**', '**/.verdict/**', '**/*.min.js', '**/*.d.ts'];

export async function listSourceFiles(root: string): Promise<string[]> {
  const files = await fg('**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true });
  return files.sort();
}

export async function listPackageFiles(root: string): Promise<string[]> {
  const files = await fg('**/package.json', { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true });
  return files.sort();
}
