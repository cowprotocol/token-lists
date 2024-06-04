import fs from 'fs';
import csv from 'csv-parser';
import { finished } from 'stream/promises';

export async function readCsv<T>(path: string) {
  const results: T[] = [];
  const stream = fs.createReadStream(path).pipe(csv());

  stream.on('data', (data) => results.push(data));

  await finished(stream);

  return results;
}