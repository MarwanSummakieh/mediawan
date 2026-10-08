import { migrateLegacy } from '../src/migrate.mjs';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: npm run migrate -- OLD.sqlite NEW.sqlite');
  process.exit(1);
}
console.log(migrateLegacy(source, destination));
