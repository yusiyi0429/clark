// Explicitly named disposable database only; never connects to shared port 5432.
const {Pool}=require(process.cwd()+'/apps/api/node_modules/pg');
const name=process.argv[2];
if(!/^warmap_test_[a-f0-9]{12}$/.test(name||'')) throw new Error('Only a named test fixture can be removed');
const admin=new Pool({connectionString:'postgres://postgres:postgres@localhost:54329/postgres',max:1});
(async()=>{try{const r=await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[name]);if(r.rows.length){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query(`DROP DATABASE "${name}"`);}console.log(JSON.stringify({removed:name,remaining:(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[name])).rowCount}));}finally{await admin.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
