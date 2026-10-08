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

// ---------- Saúde / instância (útil no vídeo da Parte 2 para ver o balanceamento) ----------
app.get('/api/health', (req, res) => res.json({ ok: true, instance: os.hostname(), redis: cache.status() }));

// Gera carga de CPU para disparar o Auto Scaling (Parte 2).
app.get('/api/stress', (req, res) => {
  const secs = Math.min(Number(req.query.s) || 30, 300);
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) crypto.pbkdf2Sync('x', 'y', 1000, 64, 'sha512');
  res.json({ instance: os.hostname(), stressed: secs });
});

// ---------- Dashboard (cacheado) ----------
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

// ---------- CRUD genérico para pacientes e médicos ----------
function crud(entity, table, fields) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => {
    send(res, await cache.wrap(`${entity}:list`, async () =>
      (await pool.query(`SELECT * FROM ${table} ORDER BY nome`)).rows));
  }));
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

// ---------- Exames (upload S3 + SNS/SQS) ----------
const EXAME_SQL = `
  SELECT e.*, p.nome AS paciente_nome, m.nome AS medico_nome
  FROM exames e JOIN pacientes p ON p.id=e.paciente_id LEFT JOIN medicos m ON m.id=e.medico_id`;

async function withUrls(e) {
  return { ...e, url_original: await storage.url(e.arquivo_original),
    url_preview: await storage.url(e.arquivo_preview), url_thumb: await storage.url(e.arquivo_thumb) };
}

app.get('/api/exames', wrap(async (req, res) => {
  const pid = req.query.paciente_id;
  const key = pid ? `exames:paciente:${pid}` : 'exames:all';
  const r = await cache.wrap(key, async () =>
    (await pool.query(`${EXAME_SQL} ${pid ? 'WHERE e.paciente_id=$1' : ''} ORDER BY e.criado_em DESC`, pid ? [pid] : [])).rows, 15);
  r.data = await Promise.all(r.data.map(withUrls)); // URLs assinadas não vão para o cache
  send(res, r);
}));

app.get('/api/exames/:id', wrap(async (req, res) => {
  const q = await pool.query(`${EXAME_SQL} WHERE e.id=$1`, [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: 'não encontrado' });
  await audit.log('READ', 'exame', { id: q.rows[0].id, paciente_id: q.rows[0].paciente_id });
  res.json(await withUrls(q.rows[0]));
}));

app.post('/api/exames', upload.single('arquivo'), wrap(async (req, res) => {
  const { paciente_id, medico_id, tipo, descricao } = req.body;
  if (!req.file) return res.status(400).json({ error: 'arquivo obrigatório' });
  if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'envie uma imagem (JPG/PNG/TIFF/WebP)' });

  const ext = path.extname(req.file.originalname) || '.img';
  const key = `exames/${paciente_id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  await storage.put(key, req.file.buffer, req.file.mimetype);

  const q = await pool.query(
    `INSERT INTO exames (paciente_id, medico_id, tipo, descricao, arquivo_original, tamanho_original)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [paciente_id, medico_id || null, tipo, descricao || null, key, req.file.size]);
  const exame = q.rows[0];

  await events.publish('EXAME_UPLOADED', { exameId: exame.id, key });
  await cache.invalidate('exames:*', 'dashboard');
  await audit.log('CREATE', 'exame', { ...exame, arquivo_nome: req.file.originalname });
  res.status(202).json(exame); // 202: processamento continua assíncrono no worker
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

pool.query(SCHEMA)
  .then(() => console.log('[db] schema ok'))
  .catch((e) => console.error('[db] falha ao migrar:', e.message))
  .finally(() => app.listen(cfg.port, () => console.log(`MedCloud em http://localhost:${cfg.port} (${os.hostname()})`)));
