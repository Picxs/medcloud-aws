const { pool } = require('./aws');

const SQL = `
CREATE TABLE IF NOT EXISTS medicos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  crm TEXT UNIQUE NOT NULL,
  especialidade TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pacientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cpf TEXT UNIQUE NOT NULL,
  nascimento DATE,
  telefone TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS exames (
  id SERIAL PRIMARY KEY,
  paciente_id INT NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  medico_id INT REFERENCES medicos(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  descricao TEXT,
  laudo TEXT,
  status TEXT NOT NULL DEFAULT 'PROCESSANDO',
  arquivo_original TEXT,
  arquivo_preview TEXT,
  arquivo_thumb TEXT,
  largura_original INT,
  altura_original INT,
  tamanho_original INT,
  tamanho_preview INT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  processado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exames_paciente ON exames(paciente_id);
`;

if (require.main === module) {
  pool.query(SQL)
    .then(() => { console.log('Migração concluída.'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
module.exports = SQL;
