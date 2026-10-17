export const MAX_BYTES = 20 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
export const TTL = 600;
export const scripts = {
  rate: `-- rate
local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`,
  init: `-- init
if redis.call('EXISTS',KEYS[1])==1 then return 0 end
redis.call('HSET',KEYS[1],'meta',ARGV[1],'token',ARGV[2])
redis.call('EXPIRE',KEYS[1],ARGV[3]); return 1`,
  upload: `-- upload
if redis.call('EXISTS',KEYS[1])==0 then return -1 end
if redis.call('HGET',KEYS[1],'token')~=ARGV[1] then return -2 end
if redis.call('HEXISTS',KEYS[1],'code')==1 then return -3 end
redis.call('HSET',KEYS[1],ARGV[2],ARGV[3]); return 1`,
  commit: `-- commit
if redis.call('EXISTS',KEYS[1])==0 then return '-1' end
if redis.call('HGET',KEYS[1],'token')~=ARGV[1] then return '-2' end
local previous=redis.call('HGET',KEYS[1],'code'); if previous then return previous end
for i=6,#ARGV do if redis.call('HEXISTS',KEYS[1],ARGV[i])==0 then return '-3' end end
if not redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[4],'NX') then return '0' end
redis.call('HSET',KEYS[1],'code',ARGV[3],'expiresAt',ARGV[5])
redis.call('EXPIRE',KEYS[1],ARGV[4]); return ARGV[3]`,
  delete: `-- delete
if redis.call('EXISTS',KEYS[1])==0 then return 0 end
if redis.call('HGET',KEYS[1],'token')~=ARGV[1] then return -2 end
if redis.call('GET',KEYS[2])==ARGV[2] then redis.call('DEL',KEYS[2]) end
redis.call('DEL',KEYS[1]); return 1`
};
