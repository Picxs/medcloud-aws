const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cfg = require('./config');
const { pool, cache, storage, audit, events } = require('./aws');
const SCHEMA = require('./migrate');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const send = (res, { data, hit }) => res.set('X-Cache', hit ? 'HIT' : 'MISS').json({ cache: hit ? 'HIT' : 'MISS', data });

// ---------- Saúde / status dos containers do Trabalho 2 ----------
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    instance: os.hostname(),
    redis: cache.status(),
    rabbitmq: events.status(),
    minioBucket: cfg.bucket,
    dynamoTable: cfg.auditTable,
    dynamoMode: cfg.dynamoEndpoint ? 'local-container' : 'aws-cloud',
  })
);

// Endpoint de carga de CPU
const { Worker } = require('worker_threads');
let stressUntil = 0;
app.get('/api/stress', (req, res) => {
  const secs = Math.min(Number(req.query.s) || 180, 600);
  if (Date.now() < stressUntil) return res.json({ instance: os.hostname(), alreadyRunning: true, until: new Date(stressUntil) });
  stressUntil = Date.now() + secs * 1000;
  for (let i = 0; i < os.cpus().length; i++) {
    new Worker(`const end=Date.now()+${secs * 1000};const c=require('crypto');while(Date.now()<end)c.pbkdf2Sync('x','y',1000,64,'sha512');`, { eval: true });
  }
  res.json({ instance: os.hostname(), threads: os.cpus().length, seconds: secs, until: new Date(stressUntil) });
});

// [REDIS] Camada de cache para o painel
app.get('/api/dashboard', wrap(async (req, res) => {
  send(res, await cache.wrap('dashboard', async () => {
    const q = await pool.query(`
      SELECT (SELECT count(*) FROM pacientes)::int AS pacientes,
             (SELECT count(*) FROM medicos)::int AS medicos,
             (SELECT count(*) FROM exames)::int AS exames,
             (SELECT count(*) FROM exames WHERE status='PROCESSANDO')::int AS processando,
             (SELECT count(*) FROM exames WHERE laudo IS NULL OR laudo='')::int AS sem_laudo`);
    return q.rows[0];
  }));
}));

// ---------- CRUD genérico para pacientes e médicos (Postgres + DynamoDB) ----------
function crud(entity, table, fields) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => {
    send(res, await cache.wrap(`${entity}:list`, async () =>
      (await pool.query(`SELECT * FROM ${table} ORDER BY nome`)).rows));
  }));
  // [TRABALHO 2 - POSTGRES E DYNAMODB] Banco relacional em container + Auditoria NoSQL.
  r.post('/', wrap(async (req, res) => {
    const vals = fields.map((f) => req.body[f] || null);
    const q = await pool.query(
      `INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    await cache.invalidate(`${entity}:list`, 'dashboard');
    await audit.log('CREATE', entity, q.rows[0]);
    res.status(201).json(q.rows[0]);
  }));
  r.put('/:id', wrap(async (req, res) => {
    const before = (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'não encontrado' });
    const vals = fields.map((f) => req.body[f] ?? before[f]);
    const q = await pool.query(
      `UPDATE ${table} SET ${fields.map((f, i) => `${f}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1} RETURNING *`,
      [...vals, req.params.id]);
    await cache.invalidate(`${entity}:list`, 'exames:*');
    await audit.log('UPDATE', entity, { antes: before, depois: q.rows[0] });
    res.json(q.rows[0]);
  }));
  r.delete('/:id', wrap(async (req, res) => {
    const q = await pool.query(`DELETE FROM ${table} WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!q.rows[0]) return res.status(404).json({ error: 'não encontrado' });
    await cache.invalidate(`${entity}:list`, 'exames:*', 'dashboard');
    await audit.log('DELETE', entity, q.rows[0]);
    res.status(204).end();
  }));
  return r;
}
app.use('/api/pacientes', crud('paciente', 'pacientes', ['nome', 'cpf', 'nascimento', 'telefone']));
app.use('/api/medicos', crud('medico', 'medicos', ['nome', 'crm', 'especialidade']));

// ---------- Exames (Upload MinIO + Mensageria RabbitMQ) ----------
const EXAME_SQL = `
  SELECT e.*, p.nome AS paciente_nome, m.nome AS medico_nome
  FROM exames e JOIN pacientes p ON p.id=e.paciente_id LEFT JOIN medicos m ON m.id=e.medico_id`;

async function withUrls(e) {
  return {
    ...e,
    url_original: await storage.url(e.arquivo_original),
    url_preview: await storage.url(e.arquivo_preview),
    url_thumb: await storage.url(e.arquivo_thumb),
  };
}

app.get('/api/exames', wrap(async (req, res) => {
  const pid = req.query.paciente_id;
  const key = pid ? `exames:paciente:${pid}` : 'exames:all';
  const r = await cache.wrap(key, async () =>
    (await pool.query(`${EXAME_SQL} ${pid ? 'WHERE e.paciente_id=$1' : ''} ORDER BY e.criado_em DESC`, pid ? [pid] : [])).rows, 15);
  r.data = await Promise.all(r.data.map(withUrls));
  send(res, r);
}));

app.get('/api/exames/:id', wrap(async (req, res) => {
  const q = await pool.query(`${EXAME_SQL} WHERE e.id=$1`, [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: 'não encontrado' });
  await audit.log('READ', 'exame', { id: q.rows[0].id, paciente_id: q.rows[0].paciente_id });
  res.json(await withUrls(q.rows[0]));
}));

// [TRABALHO 2 - MINIO + RABBITMQ] Upload do arquivo no MinIO e publicação na fila do RabbitMQ
app.post('/api/exames', upload.single('arquivo'), wrap(async (req, res) => {
  const { paciente_id, medico_id, tipo, descricao } = req.body;
  if (!req.file) return res.status(400).json({ error: 'arquivo obrigatório' });
  if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'envie uma imagem (JPG/PNG/TIFF/WebP)' });

  const ext = path.extname(req.file.originalname) || '.img';
  const key = `exames/${paciente_id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  // 1. Envia a imagem bruta original para o bucket no MinIO
  await storage.put(key, req.file.buffer, req.file.mimetype);

  // 2. Persiste os metadados do exame no PostgreSQL
  const q = await pool.query(
    `INSERT INTO exames (paciente_id, medico_id, tipo, descricao, arquivo_original, tamanho_original)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [paciente_id, medico_id || null, tipo, descricao || null, key, req.file.size]);
  const exame = q.rows[0];

  // 3. Publica mensagem na fila do RabbitMQ para processamento assíncrono pelo Worker
  await events.publish('EXAME_UPLOADED', { exameId: exame.id, key });
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log('CREATE', 'exame', { ...exame, arquivo_nome: req.file.originalname });
  res.status(202).json(exame);
}));

app.put('/api/exames/:id', wrap(async (req, res) => {
  const before = (await pool.query('SELECT * FROM exames WHERE id=$1', [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error: 'não encontrado' });
  const { tipo, descricao, laudo, medico_id } = req.body;
  const q = await pool.query(
    `UPDATE exames SET tipo=$1, descricao=$2, laudo=$3, medico_id=$4 WHERE id=$5 RETURNING *`,
    [tipo ?? before.tipo, descricao ?? before.descricao, laudo ?? before.laudo, medico_id ?? before.medico_id, req.params.id]);
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log('UPDATE', 'exame', { antes: before, depois: q.rows[0] });
  res.json(q.rows[0]);
}));

app.delete('/api/exames/:id', wrap(async (req, res) => {
  const q = await pool.query('DELETE FROM exames WHERE id=$1 RETURNING *', [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: 'não encontrado' });
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log('DELETE', 'exame', q.rows[0]);
  res.status(204).end();
}));

// ---------- Auditoria (DynamoDB) ----------
app.get('/api/auditoria', wrap(async (req, res) => res.json(await audit.recent(Number(req.query.limit) || 50))));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.code === '23505' ? 409 : 500).json({ error: err.code === '23505' ? 'registro duplicado (CPF/CRM)' : err.message });
});

async function bootstrap() {
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      await pool.query(SCHEMA);
      console.log('[postgres] schema verificado com sucesso');
      break;
    } catch (e) {
      console.warn(`[postgres] aguardando banco (${attempt}/15):`, e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await storage.init().catch((e) => console.error('[minio] erro ao inicializar bucket:', e.message));
  await audit.init().catch((e) => console.error('[dynamodb] erro ao inicializar tabela:', e.message));
  await events.init().catch((e) => console.error('[rabbitmq] erro ao inicializar fila:', e.message));

  app.listen(cfg.port, () => console.log(`MedCloud Backend rodando em http://0.0.0.0:${cfg.port} (${os.hostname()})`));
}

bootstrap();
