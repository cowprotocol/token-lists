import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export const ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
