/* Generate a bcrypt hash for seeding the first admin.
   Usage:  node scripts/hash.js "YourPassword123!"            */
const bcrypt = require('bcryptjs');
const pw = process.argv[2];
if (!pw) { console.error('Usage: node scripts/hash.js "YourPassword"'); process.exit(1); }
console.log(bcrypt.hashSync(pw, 10));
