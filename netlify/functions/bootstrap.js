/* One-time creation of the first administrator.
   Protected by BOOTSTRAP_SECRET and refuses to run once any admin exists. */
const L = require('./_lib');

exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') return L.J(405, { error:'Use POST' });
  const secret = process.env.BOOTSTRAP_SECRET;
  if(!secret) return L.J(403, { error:'BOOTSTRAP_SECRET is not set' });

  let b = {};
  try{ b = JSON.parse(event.body||'{}'); }catch{}
  if(b.secret !== secret) return L.J(403, { error:'Bad bootstrap secret' });

  const sql = L.db();
  try{
    const [{count}] = await sql`SELECT COUNT(*)::int FROM accounts WHERE role='admin'`;
    if(count > 0) return L.J(409, { error:'An administrator already exists. Use the admin console.' });

    const username = (b.username||'admin').toLowerCase();
    const password = b.password;
    if(!password || String(password).length < 12)
      return L.J(400, { error:'Provide a password of at least 12 characters' });

    const mfaSecret = L.randomSecret();
    const [row] = await sql`
      INSERT INTO accounts (username,email,password_hash,role,full_name,title,initials,scope,
                            mfa_enabled,mfa_secret,must_change,created_by)
      VALUES (${username},${b.email||null},${L.hashPassword(password)},'admin',
              ${b.full_name||'System Administrator'},'Platform Admin',
              ${b.initials||'SA'},'all',FALSE,${mfaSecret},FALSE,'bootstrap')
      RETURNING id,username`;

    return L.J(201, {
      ok:true, account: row,
      mfa: { secret: mfaSecret, otpauth: L.otpauth(username, mfaSecret) },
      next:'Delete BOOTSTRAP_SECRET from your environment variables now.'
    });
  }catch(err){
    return L.J(500, { error:'server', message:String(err.message||err) });
  }
};
